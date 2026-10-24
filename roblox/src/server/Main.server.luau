-- The Roblox game server's half of cross-play. Players here join CFO rooms on the website, so they
-- can play against people in a browser. This script only relays: it joins players, forwards their
-- moves, and polls the website every couple of seconds, sending each player their own view. All
-- rules, and the list of moves each player may make, come from the website.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Bridge = require(ReplicatedStorage:WaitForChild("CfoShared"):WaitForChild("Bridge"))
local Api = require(script.Parent:WaitForChild("Api"))

local remotes = Instance.new("Folder")
remotes.Name = "CfoRemotes"
local requestFn = Instance.new("RemoteFunction")
requestFn.Name = "Request"
requestFn.Parent = remotes
local stateEvent = Instance.new("RemoteEvent")
stateEvent.Name = "State"
stateEvent.Parent = remotes
remotes.Parent = ReplicatedStorage

type Room = { players: { [Player]: boolean }, version: number, polling: boolean }
local rooms: { [string]: Room } = {}
local roomOf: { [Player]: string } = {}
local lastRequest: { [Player]: number } = {}

local function userIds(room: Room): { string }
	local ids = {}
	for p in room.players do
		table.insert(ids, tostring(p.UserId))
	end
	return ids
end

-- Asks the website for anything new in the room and sends each player here their view.
local function refresh(code: string)
	local room = rooms[code]
	if not room or next(room.players) == nil then
		return
	end
	local res, err = Api.room(code, { op = "poll", userIds = userIds(room), since = room.version })
	if not res then
		for p in room.players do
			stateEvent:FireClient(p, { error = err })
		end
		return
	end
	if Bridge.updateNeeded(res.bridge) then
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

local function keepPolling(code: string)
	local room = rooms[code]
	if room.polling then
		return
	end
	room.polling = true
	task.spawn(function()
		while rooms[code] == room and next(room.players) ~= nil do
			refresh(code)
			task.wait(Bridge.POLL_SECONDS)
		end
		room.polling = false
	end)
end

local function leave(player: Player)
	local code = roomOf[player]
	if not code then
		return
	end
	roomOf[player] = nil
	local room = rooms[code]
	if room then
		room.players[player] = nil
		if next(room.players) == nil then
			rooms[code] = nil
		end
	end
	-- Gives up a lobby seat; mid-game the seat is kept so the player can come back.
	task.spawn(Api.room, code, { op = "leave", userId = tostring(player.UserId) })
end

local function join(player: Player, code: string)
	if roomOf[player] ~= code then
		leave(player)
	end
	local res, err = Api.room(code, { op = "join", userId = tostring(player.UserId), name = player.DisplayName })
	if not res then
		return { error = err }
	end
	if Bridge.updateNeeded(res.bridge) then
		return { error = "This Roblox game needs an update to play the latest version of CFO." }
	end
	local room = rooms[code] or { players = {}, version = -1, polling = false }
	rooms[code] = room
	room.players[player] = true
	room.version = -1 -- so the new player is sent the room straight away
	roomOf[player] = code
	stateEvent:FireClient(player, { code = code, board = res.board })
	keepPolling(code)
	task.spawn(refresh, code)
	return { ok = true, seat = res.seat }
end

requestFn.OnServerInvoke = function(player: Player, kind: any, arg: any)
	local now = os.clock()
	if now - (lastRequest[player] or 0) < 0.25 then
		return { error = "Slow down a little." }
	end
	lastRequest[player] = now
	if kind == "new" then
		local code, err = Api.newRoom()
		if not code then
			return { error = err }
		end
		return join(player, code)
	elseif kind == "join" then
		if type(arg) ~= "string" or not arg:match("^%w%w%w%w+$") or #arg > 12 then
			return { error = "Room codes are 4 to 12 letters and numbers." }
		end
		return join(player, arg:upper())
	elseif kind == "leave" then
		leave(player)
		return { ok = true }
	elseif kind == "send" then
		local code = roomOf[player]
		local msg = Bridge.cleanMessage(arg)
		if not code or not msg then
			return { error = "That move could not be sent." }
		end
		local res, err = Api.room(code, { op = "act", userId = tostring(player.UserId), msg = msg })
		task.spawn(refresh, code)
		if not res then
			return { error = err }
		end
		return { error = res.error }
	end
	return { error = "Unknown request." }
end

Players.PlayerRemoving:Connect(function(player)
	leave(player)
	lastRequest[player] = nil
end)

game:BindToClose(function()
	for _, player in Players:GetPlayers() do
		leave(player)
	end
	task.wait(1) -- lets the leave requests go out
end)
