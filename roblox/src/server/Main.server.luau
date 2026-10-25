-- The hub's game server: players here pick a game and join its rooms on the website, so they can
-- play against people in a browser. This script only relays: it joins players, forwards their
-- moves, and polls the website every couple of seconds, sending each player their own view. All
-- rules, and the list of moves each player may make, come from the website. Nothing here is about
-- one game: each game's module in shared/games says which bridge version it speaks and how to
-- clean a move.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Shared = ReplicatedStorage:WaitForChild("HubShared")
local Hub = require(Shared:WaitForChild("Hub"))
local Api = require(script.Parent:WaitForChild("Api"))

-- Every game this build has, by website id.
local games: { [string]: any } = {}
for _, m in Shared:WaitForChild("games"):GetChildren() do
	if m:IsA("ModuleScript") then
		local g = require(m) :: any
		games[g.ID] = g
	end
end

local remotes = Instance.new("Folder")
remotes.Name = "HubRemotes"
local requestFn = Instance.new("RemoteFunction")
requestFn.Name = "Request"
requestFn.Parent = remotes
local stateEvent = Instance.new("RemoteEvent")
stateEvent.Name = "State"
stateEvent.Parent = remotes
remotes.Parent = ReplicatedStorage

type Room = { game: string, code: string, players: { [Player]: boolean }, version: number, polling: boolean }
local rooms: { [string]: Room } = {} -- by "<game>/<code>"
local roomOf: { [Player]: string } = {}
local queued: { [Player]: string } = {} -- the game a player is waiting in quick match for
local lastRequest: { [Player]: number } = {}

-- The website's list of games, asked for now and then; the picker shows the ones this build has.
local listed: any = nil
local listedAt = -math.huge
local function gameList(): (any?, string?)
	if listed and os.clock() - listedAt < 60 then
		return listed
	end
	local res, err = Api.games()
	if not res then
		return listed, if listed then nil else err
	end
	listed = Hub.playable(res.games, games)
	listedAt = os.clock()
	return listed
end

local function userIds(room: Room): { string }
	local ids = {}
	for p in room.players do
		table.insert(ids, tostring(p.UserId))
	end
	return ids
end

-- Asks the website for anything new in the room and sends each player here their view.
local function refresh(key: string)
	local room = rooms[key]
	if not room or next(room.players) == nil then
		return
	end
	local res, err = Api.room(room.game, room.code, { op = "poll", userIds = userIds(room), since = room.version })
	if not res then
		for p in room.players do
			stateEvent:FireClient(p, { error = err })
		end
		return
	end
	if Hub.updateNeeded(games[room.game].SUPPORTED, res.bridge) then
		for p in room.players do
			stateEvent:FireClient(p, { updateNeeded = true })
		end
	end
	if res.same then
		return
	end
	room.version = res.version
	for p in room.players do
		local view = res.views and res.views[tostring(p.UserId)]
		if view then
			stateEvent:FireClient(p, { view = view })
		end
	end
end

local function keepPolling(key: string)
	local room = rooms[key]
	if room.polling then
		return
	end
	room.polling = true
	task.spawn(function()
		while rooms[key] == room and next(room.players) ~= nil do
			refresh(key)
			task.wait(Hub.POLL_SECONDS)
		end
		room.polling = false
	end)
end

local function leave(player: Player)
	local key = roomOf[player]
	if not key then
		return
	end
	roomOf[player] = nil
	local room = rooms[key]
	if not room then
		return
	end
	room.players[player] = nil
	if next(room.players) == nil then
		rooms[key] = nil
	end
	-- Gives up a lobby seat; mid-game the seat is kept so the player can come back.
	task.spawn(Api.room, room.game, room.code, { op = "leave", userId = tostring(player.UserId) })
end

local function join(player: Player, gameId: string, code: string, expect: number?)
	local key = gameId .. "/" .. code
	if roomOf[player] ~= key then
		leave(player)
	end
	local res, err = Api.room(gameId, code, { op = "join", userId = tostring(player.UserId), name = player.DisplayName, expect = expect })
	if not res then
		return { error = err }
	end
	if Hub.updateNeeded(games[gameId].SUPPORTED, res.bridge) then
		return { error = "This Roblox game needs an update to play the latest version of this game." }
	end
	local room = rooms[key] or { game = gameId, code = code, players = {}, version = -1, polling = false }
	rooms[key] = room
	room.players[player] = true
	room.version = -1 -- so the new player is sent the room straight away
	roomOf[player] = key
	stateEvent:FireClient(player, { game = gameId, code = code, board = res.board })
	keepPolling(key)
	task.spawn(refresh, key)
	return { ok = true, seat = res.seat }
end

-- Quick match: asks the website's queue every couple of seconds for as long as the player waits,
-- telling them how it stands, and joins the room it hands out. The place lapses on the website if
-- the asking stops, so a server that goes away leaves nobody stuck in the queue.
local function stopQueue(player: Player)
	local gameId = queued[player]
	if gameId then
		queued[player] = nil
		task.spawn(Api.match, gameId, tostring(player.UserId), "leave")
	end
end

local function quickMatch(player: Player, gameId: string)
	if queued[player] == gameId then
		return { ok = true }
	end
	stopQueue(player)
	leave(player)
	queued[player] = gameId
	task.spawn(function()
		local op = "join"
		while queued[player] == gameId do
			local res, err = Api.match(gameId, tostring(player.UserId), op)
			op = "poll"
			if queued[player] ~= gameId then
				break
			end
			if not res then
				queued[player] = nil
				stateEvent:FireClient(player, { queue = false, error = err })
				break
			end
			if res.matched then
				queued[player] = nil
				local joined = join(player, gameId, res.matched.room, res.matched.players)
				if joined.error then
					stateEvent:FireClient(player, { queue = false, error = joined.error })
				end
				break
			end
			local q = res.queued or {}
			local startsIn = if q.startsAt then (q.startsAt - DateTime.now().UnixTimestampMillis) / 1000 else nil
			stateEvent:FireClient(player, { queue = { waiting = q.waiting, max = q.max, startsIn = startsIn } })
			task.wait(Hub.POLL_SECONDS)
		end
	end)
	return { ok = true }
end

-- The game a request is about, when this build has it.
local function gameOf(arg: any): string?
	local id = Hub.gameId(if type(arg) == "table" then arg.game else arg)
	return if id and games[id] then id else nil
end

requestFn.OnServerInvoke = function(player: Player, kind: any, arg: any)
	local now = os.clock()
	if now - (lastRequest[player] or 0) < 0.25 then
		return { error = "Slow down a little." }
	end
	lastRequest[player] = now
	if kind == "hello" then
		-- What the picker needs: the games, and whether this player is linked (with their rooms).
		local list, err = gameList()
		local link = Api.link(tostring(player.UserId), "status")
		return if list then { games = list, link = link } else { error = err, link = link }
	elseif kind == "quick" then
		local gameId = gameOf(arg)
		return if gameId then quickMatch(player, gameId) else { error = "Pick a game first." }
	elseif kind == "cancel" then
		stopQueue(player)
		return { ok = true }
	elseif kind == "new" then
		stopQueue(player)
		local gameId = gameOf(arg)
		if not gameId then
			return { error = "Pick a game first." }
		end
		local code, err = Api.newRoom()
		if not code then
			return { error = err }
		end
		return join(player, gameId, code)
	elseif kind == "join" then
		stopQueue(player)
		local gameId = gameOf(arg)
		local code = Hub.roomCode(type(arg) == "table" and arg.code)
		if not gameId then
			return { error = "Pick a game first." }
		elseif not code then
			return { error = "Room codes are 4 to 12 letters and numbers." }
		end
		return join(player, gameId, code)
	elseif kind == "leave" then
		leave(player)
		return { ok = true }
	elseif kind == "account" then
		-- Whether this player is linked to an account, and that account's games in progress.
		local res, err = Api.link(tostring(player.UserId), "status")
		return if res then { link = res } else { error = err }
	elseif kind == "link" then
		if type(arg) ~= "string" or not arg:match("^%s*%w+%s*$") or #arg > 16 then
			return { error = "Link codes are letters and numbers." }
		end
		local res, err = Api.link(tostring(player.UserId), "redeem", player.DisplayName, arg)
		return if res then { link = res } else { error = err }
	elseif kind == "unlink" then
		local res, err = Api.link(tostring(player.UserId), "unlink")
		return if res then { link = res } else { error = err }
	elseif kind == "send" then
		local key = roomOf[player]
		local room = key and rooms[key]
		local msg = room and games[room.game].cleanMessage(arg)
		if not room or not msg then
			return { error = "That move could not be sent." }
		end
		local res, err = Api.room(room.game, room.code, { op = "act", userId = tostring(player.UserId), msg = msg })
		task.spawn(refresh, key)
		if not res then
			return { error = err }
		end
		return { error = res.error }
	end
	return { error = "Unknown request." }
end

Players.PlayerRemoving:Connect(function(player)
	stopQueue(player)
	leave(player)
	lastRequest[player] = nil
end)

game:BindToClose(function()
	for _, player in Players:GetPlayers() do
		stopQueue(player)
		leave(player)
	end
	task.wait(1) -- lets the leave requests go out
end)
