-- The hub's screens: a game picker with the player's account link and their games to rejoin, then
-- each game's lobby (quick match, a new room, or a room code) and waiting room. Once a game is on,
-- that game's own screens (client/games) draw it. Games are shared with players on the website,
-- which says which games are on Roblox; the picker shows those this build has screens for.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")

local Shared = ReplicatedStorage:WaitForChild("HubShared")
local Hub = require(Shared:WaitForChild("Hub"))
local Ui = require(script.Parent:WaitForChild("Ui"))
local remotes = ReplicatedStorage:WaitForChild("HubRemotes")
local requestFn: RemoteFunction = remotes:WaitForChild("Request")
local stateEvent: RemoteEvent = remotes:WaitForChild("State")

local player = Players.LocalPlayer
local make, label, heading, small, button, column, textBox = Ui.make, Ui.label, Ui.heading, Ui.small, Ui.button, Ui.column, Ui.textBox
local corner, stroke, pad, playerColor = Ui.corner, Ui.stroke, Ui.pad, Ui.playerColor
local BG, PANEL, ACCENT, BAD = Ui.BG, Ui.PANEL, Ui.ACCENT, Ui.BAD

-- What the client knows: the games on offer, the game picked, its room code and fixed board, and
-- the latest view from the server.
local state = {
	games = nil :: { any }?, -- the website's list, kept to games this build has
	game = nil :: string?,
	code = nil :: string?,
	board = nil :: any,
	view = nil :: any,
	error = nil :: string?,
	updateNeeded = false,
	queue = nil :: any,
	link = nil :: any,
}
-- What this player has open or typed, kept across redraws. Each game keeps its own fields here.
local ui: { [string]: any } = { confirming = nil :: string? } -- a button waiting for a second tap

local gui = make("ScreenGui", { Name = "Hub", ResetOnSpawn = false, IgnoreGuiInset = true, ZIndexBehavior = Enum.ZIndexBehavior.Sibling, Parent = player:WaitForChild("PlayerGui") })
local root = make("Frame", { Size = UDim2.fromScale(1, 1), BackgroundColor3 = BG, BorderSizePixel = 0, Parent = gui })

local render: () -> ()
local screens: { [string]: any } = {} -- each game's screens, by website id

local function resetGame()
	local keep = ui.confirming
	table.clear(ui)
	ui.confirming = keep
	local s = state.game and screens[state.game]
	if s then
		s.reset()
	end
end

local account: (kind: string, arg: any?) -> ()

local function call(kind: string, arg: any?): any
	local ok, res = pcall(function()
		return requestFn:InvokeServer(kind, arg)
	end)
	state.error = if not ok then "Lost touch with the server." elseif res and res.error then res.error else nil
	if kind == "leave" and ok then
		state.code, state.view, state.board, state.updateNeeded = nil, nil, nil, false
		resetGame()
		task.spawn(account, "account") -- the account's list of games may have changed
	end
	if kind == "cancel" then
		state.queue = nil
	end
	render()
	return if ok and res and not res.error then res else nil
end

local function send(msg: any): any
	return call("send", msg)
end

-- Whether this player is linked to an account, and its games in progress to rejoin.
function account(kind: string, arg: any?)
	local res = call(kind, arg)
	if res and res.link then
		state.link = res.link
		render()
	end
end

-- The games on offer, and the account link, when the hub opens.
local function loadGames()
	local ok, res = pcall(function()
		return requestFn:InvokeServer("hello")
	end)
	if ok and res and res.link then
		state.link = res.link
	end
	if ok and res and res.games then
		state.games = res.games
	end
	state.error = if not ok then "Lost touch with the server." elseif res and res.error then res.error else nil
	render()
end

-- A button that asks for a second tap before it does something hard to undo.
local function confirmButton(key: string, text: string, onClick: () -> (), props: { [string]: any }?, kind: string?)
	local armed = ui.confirming == key
	return button(if armed then "Tap again: " .. text else text, function()
		if ui.confirming ~= key then
			ui.confirming = key
			render()
			return
		end
		ui.confirming = nil
		onClick()
	end, props, if armed then "danger" else kind)
end

local function errorLine(parent: Instance, order: number)
	if state.error then
		label(state.error, { TextColor3 = BAD, Parent = parent, LayoutOrder = order })
	end
end

-- Every game this build has: its shared helpers (shared/games) and its screens (client/games),
-- matched by module name.
for _, m in script.Parent:WaitForChild("games"):GetChildren() do
	if m:IsA("ModuleScript") then
		local bridge = require(Shared:WaitForChild("games"):WaitForChild(m.Name)) :: any
		screens[bridge.ID] = (require(m) :: any)({
			Ui = Ui,
			bridge = bridge,
			state = state,
			ui = ui,
			root = root,
			call = call,
			send = send,
			render = function()
				render()
			end,
			confirmButton = confirmButton,
			errorLine = errorLine,
		})
		screens[bridge.ID].reset()
	end
end

local function gameInfo(id: string?): any
	for _, g in state.games or {} do
		if g.id == id then
			return g
		end
	end
	return nil
end

local function pickGame(id: string?)
	state.game = id
	state.error = nil
	resetGame()
	render()
end

---------------------------------------------------------------------------------------------------
-- The hub

local function centerCard(width: number?): Frame
	local box = make("Frame", { AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromScale(0.5, 0.5), Size = UDim2.new(0, width or 360, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, BackgroundColor3 = PANEL, Parent = root }, { corner(10), stroke(), pad(18) })
	return column({ Parent = box }, 8)
end

-- A linked player plays as their account in every game: its rooms and admin role go with them. The
-- code comes from the account's page; this game never says where that is.
local function renderLink(col: Frame, order: number)
	local link = state.link
	if link and link.linked then
		heading(if link.admin then "Linked to your account (admin)" else "Linked to your account", { TextSize = 14, Parent = col, LayoutOrder = order })
		for i, r in Hub.rejoins(link, screens, 5) do
			local info = gameInfo(r.game)
			button("Rejoin " .. (if info then info.name .. " " else "") .. "game " .. r.code, function()
				pickGame(r.game)
				call("join", { game = r.game, code = r.code })
			end, { Parent = col, LayoutOrder = order + i }, "secondary")
		end
		confirmButton("unlink", "Unlink account", function()
			account("unlink")
		end, { Parent = col, LayoutOrder = order + 7 }, "secondary")
	else
		small("Have a link code? Enter it to keep your games and admin role with your account.", { Parent = col, LayoutOrder = order })
		local box = textBox({ PlaceholderText = "Link code", Font = Enum.Font.GothamMedium, TextSize = 16, Parent = col, LayoutOrder = order + 1 })
		button("Link", function()
			account("link", box.Text)
		end, { Parent = col, LayoutOrder = order + 2 }, "secondary")
	end
end

-- Every game on offer, then the account link.
local function renderPicker()
	local col = centerCard(400)
	label("Live Multiplayer Games", { Font = Enum.Font.GothamBold, TextSize = 26, TextColor3 = ACCENT, Parent = col, LayoutOrder = 1 })
	small("Pick a game. Every game is shared with players on the website.", { TextSize = 13, Parent = col, LayoutOrder = 2 })
	if not state.games then
		small(if state.error then "The games could not be loaded." else "Loading the games…", { Parent = col, LayoutOrder = 3 })
		if state.error then
			button("Try again", loadGames, { Parent = col, LayoutOrder = 4 }, "secondary")
		end
	elseif #state.games == 0 then
		small("No games are on Roblox right now.", { Parent = col, LayoutOrder = 3 })
	end
	for i, g in state.games or {} do
		local f = make("Frame", { BackgroundColor3 = Ui.PANEL2, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0), Parent = col, LayoutOrder = 10 + i }, { corner(8), stroke(), pad(10) })
		local c = column({ Parent = f }, 4)
		heading(g.name, { Parent = c, LayoutOrder = 1 })
		small(g.blurb .. " " .. g.players .. " players.", { Parent = c, LayoutOrder = 2 })
		button("Play " .. g.name, function()
			pickGame(g.id)
		end, { Parent = c, LayoutOrder = 3 })
	end
	renderLink(col, 40)
	errorLine(col, 60)
end

-- One game's lobby: quick match, a new room, or a room code.
local function renderLobby(info: any)
	local col = centerCard()
	label(info.name, { Font = Enum.Font.GothamBold, TextSize = 30, TextColor3 = ACCENT, Parent = col, LayoutOrder = 1 })
	small(info.blurb .. " Games are shared with players on the website.", { TextSize = 13, Parent = col, LayoutOrder = 2 })
	if state.queue then
		label(Hub.queueText(state.queue), { Parent = col, LayoutOrder = 3 })
		button("Cancel", function()
			call("cancel")
		end, { Parent = col, LayoutOrder = 4 }, "secondary")
	else
		button("Quick match", function()
			state.queue = { waiting = 1, max = info.maxPlayers }
			call("quick", info.id)
		end, { Parent = col, LayoutOrder = 3 })
		small("Plays the next game with whoever is looking, on Roblox or the web.", { Parent = col, LayoutOrder = 4 })
		button("New room", function()
			call("new", info.id)
		end, { Parent = col, LayoutOrder = 5 }, "secondary")
		local code = textBox({ PlaceholderText = "Room code", Font = Enum.Font.GothamMedium, TextSize = 16, Parent = col, LayoutOrder = 6 })
		button("Join", function()
			call("join", { game = info.id, code = code.Text })
		end, { Parent = col, LayoutOrder = 7 }, "secondary")
		button("All games", function()
			pickGame(nil)
		end, { Parent = col, LayoutOrder = 8 }, "link")
	end
	errorLine(col, 20)
end

-- Waiting for the host to start. Every game's room sends its seats and host the same way.
local function renderWaiting(view: any, info: any)
	local col = centerCard()
	label((if info then info.name .. " · " else "") .. "Room " .. (state.code or ""), { Font = Enum.Font.GothamBold, TextSize = 24, Parent = col, LayoutOrder = 1 })
	local min = (info and info.minPlayers) or (state.board and state.board.minPlayers) or 2
	local max = (info and info.maxPlayers) or (state.board and state.board.maxPlayers) or min
	small("Share the room code. " .. (if min == max then min .. " players." else min .. " to " .. max .. " players."), { TextSize = 13, Parent = col, LayoutOrder = 2 })
	for i, s in view.seats do
		local mine = view.seat ~= nil and view.seat + 1 == i
		local text = s.name .. (if mine then " (you)" else "") .. (if s.platform == "web" then " · web" else "") .. (if view.host + 1 == i then " · host" else "")
		label("●  " .. text, { TextColor3 = playerColor(i), Parent = col, LayoutOrder = 10 + i })
	end
	if view.seat ~= nil and view.host == view.seat then
		button("Start the game", function()
			send({ t = "start" })
		end, { Parent = col, LayoutOrder = 30 })
	elseif view.seat == nil then
		label("This room is full, so you are watching.", { Parent = col, LayoutOrder = 30 })
	else
		small("Waiting for the host to start.", { TextSize = 13, Parent = col, LayoutOrder = 30 })
	end
	button("Leave", function()
		call("leave")
	end, { Parent = col, LayoutOrder = 31 }, "secondary")
	errorLine(col, 32)
end

-- Redrawing pulls the cursor out of a box being typed in, so a redraw waits until typing stops.
local waiting = false
function render()
	if UserInputService:GetFocusedTextBox() then
		waiting = true
		return
	end
	waiting = false
	root:ClearAllChildren()
	local view = state.view
	local info = gameInfo(state.game)
	local s = state.game and screens[state.game]
	if state.code and view and s then
		if view.status == "waiting" or not view.game then
			renderWaiting(view, info)
		else
			s.render(view)
		end
	elseif info and s then
		renderLobby(info)
	else
		renderPicker()
	end
end

UserInputService.TextBoxFocusReleased:Connect(function()
	-- A little later, so a button pressed to end the typing still gets its press.
	task.delay(0.3, function()
		if waiting then
			render()
		end
	end)
end)

stateEvent.OnClientEvent:Connect(function(msg)
	if msg.code then
		state.game = msg.game
		state.code = msg.code
		state.board = msg.board
		state.view = nil
		state.queue = nil
		state.updateNeeded = false
		resetGame()
	end
	if msg.queue ~= nil then
		state.queue = msg.queue or nil
	end
	if msg.updateNeeded then
		state.updateNeeded = true
	end
	if msg.error then
		state.error = msg.error
	end
	if msg.view then
		local s = state.game and screens[state.game]
		if s and s.onView then
			s.onView(state.view, msg.view)
		end
		state.view = msg.view
		state.error = nil
	end
	render()
end)

render()
task.spawn(loadGames)
