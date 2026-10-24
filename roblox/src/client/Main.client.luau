-- The CFO screens on Roblox: a lobby to make or join a room, then the board, the players, the log
-- and a button for every move the website says this player can make. Nothing here knows the
-- rules, so web changes show up without a Roblox update: new moves arrive with their own labels.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")

local Bridge = require(ReplicatedStorage:WaitForChild("CfoShared"):WaitForChild("Bridge"))
local remotes = ReplicatedStorage:WaitForChild("CfoRemotes")
local requestFn: RemoteFunction = remotes:WaitForChild("Request")
local stateEvent: RemoteEvent = remotes:WaitForChild("State")

local player = Players.LocalPlayer

local PLAYER_COLORS = { "#5ad1a5", "#f0b429", "#7aa2ff", "#ff7a9c", "#c792ea", "#ff9f43" }
local INK = Color3.fromHex("#1f2328")
local MUTED = Color3.fromHex("#6b7280")
local PAPER = Color3.fromHex("#f6f5f1")
local CARD = Color3.fromHex("#ffffff")
local ACCENT = Color3.fromHex("#2f6fde")
local BAD = Color3.fromHex("#c0392b")

-- What the client knows: the room code, the fixed board, and the latest view from the server.
local state = { code = nil :: string?, board = nil :: any, view = nil :: any, error = nil :: string?, updateNeeded = false }
local typed: { [string]: string } = {} -- text typed into amount boxes, kept across redraws
local confirming: string? = nil -- the label of a move waiting for a second tap

local function make(className: string, props: { [string]: any }, children: { Instance }?): any
	local inst = Instance.new(className)
	for k, v in props do
		if k ~= "Parent" then
			(inst :: any)[k] = v
		end
	end
	for _, child in children or {} do
		child.Parent = inst
	end
	if props.Parent then
		inst.Parent = props.Parent
	end
	return inst
end

local function corner(radius: number?)
	return make("UICorner", { CornerRadius = UDim.new(0, radius or 6) })
end

local function label(text: string, props: { [string]: any }?): TextLabel
	local p = {
		BackgroundTransparency = 1,
		Text = text,
		TextColor3 = INK,
		Font = Enum.Font.Gotham,
		TextSize = 14,
		TextWrapped = true,
		TextXAlignment = Enum.TextXAlignment.Left,
		AutomaticSize = Enum.AutomaticSize.Y,
		Size = UDim2.new(1, 0, 0, 0),
	}
	for k, v in props or {} do
		p[k] = v
	end
	return make("TextLabel", p)
end

local function button(text: string, onClick: () -> (), props: { [string]: any }?): TextButton
	local p = {
		Text = text,
		TextColor3 = Color3.new(1, 1, 1),
		BackgroundColor3 = ACCENT,
		Font = Enum.Font.GothamMedium,
		TextSize = 14,
		TextWrapped = true,
		AutoButtonColor = true,
		AutomaticSize = Enum.AutomaticSize.Y,
		Size = UDim2.new(1, 0, 0, 32),
	}
	for k, v in props or {} do
		p[k] = v
	end
	local b = make("TextButton", p, { corner(), make("UIPadding", { PaddingLeft = UDim.new(0, 8), PaddingRight = UDim.new(0, 8), PaddingTop = UDim.new(0, 6), PaddingBottom = UDim.new(0, 6) }) })
	b.Activated:Connect(onClick)
	return b
end

local function column(props: { [string]: any }?): Frame
	local p = { BackgroundTransparency = 1, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0) }
	for k, v in props or {} do
		p[k] = v
	end
	return make("Frame", p, { make("UIListLayout", { Padding = UDim.new(0, 6), SortOrder = Enum.SortOrder.LayoutOrder }) })
end

local gui = make("ScreenGui", { Name = "Cfo", ResetOnSpawn = false, IgnoreGuiInset = true, ZIndexBehavior = Enum.ZIndexBehavior.Sibling, Parent = player:WaitForChild("PlayerGui") })
local root = make("Frame", { Size = UDim2.fromScale(1, 1), BackgroundColor3 = PAPER, BorderSizePixel = 0, Parent = gui })

local render: () -> ()

local function call(kind: string, arg: any?)
	local ok, res = pcall(function()
		return requestFn:InvokeServer(kind, arg)
	end)
	state.error = if not ok then "Lost touch with the server." elseif res and res.error then res.error else nil
	if kind == "leave" and ok then
		state.code, state.view, state.board = nil, nil, nil
	end
	render()
end

local function send(msg: any)
	call("send", msg)
end

-- The lobby: make a room or join one by its code.
local function renderLobby()
	local box = make("Frame", { AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromScale(0.5, 0.5), Size = UDim2.new(0, 340, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, BackgroundColor3 = CARD, Parent = root }, { corner(10), make("UIPadding", { PaddingLeft = UDim.new(0, 18), PaddingRight = UDim.new(0, 18), PaddingTop = UDim.new(0, 18), PaddingBottom = UDim.new(0, 18) }) })
	local col = column({ Parent = box })
	label("CFO", { Font = Enum.Font.GothamBold, TextSize = 28, Parent = col, LayoutOrder = 1 })
	label("Run a company, keep the books, and outlast the other CFOs. Rooms are shared with players on the website.", { TextColor3 = MUTED, Parent = col, LayoutOrder = 2 })
	button("New room", function()
		call("new")
	end, { Parent = col, LayoutOrder = 3 })
	local code = make("TextBox", { PlaceholderText = "Room code", Text = "", ClearTextOnFocus = false, Font = Enum.Font.GothamMedium, TextSize = 16, TextColor3 = INK, BackgroundColor3 = PAPER, Size = UDim2.new(1, 0, 0, 34), Parent = col, LayoutOrder = 4 }, { corner() })
	button("Join", function()
		call("join", code.Text)
	end, { Parent = col, LayoutOrder = 5, BackgroundColor3 = INK })
	if state.error then
		label(state.error, { TextColor3 = BAD, Parent = col, LayoutOrder = 6 })
	end
end

-- Waiting for the host to start.
local function renderWaiting(view: any)
	local box = make("Frame", { AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromScale(0.5, 0.5), Size = UDim2.new(0, 340, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, BackgroundColor3 = CARD, Parent = root }, { corner(10), make("UIPadding", { PaddingLeft = UDim.new(0, 18), PaddingRight = UDim.new(0, 18), PaddingTop = UDim.new(0, 18), PaddingBottom = UDim.new(0, 18) }) })
	local col = column({ Parent = box })
	label("Room " .. (state.code or ""), { Font = Enum.Font.GothamBold, TextSize = 24, Parent = col, LayoutOrder = 1 })
	label("Share the room code. Up to " .. (state.board and state.board.maxPlayers or 6) .. " players.", { TextColor3 = MUTED, Parent = col, LayoutOrder = 2 })
	for i, s in view.seats do
		local mine = view.seat ~= nil and view.seat + 1 == i
		local text = s.name .. (if mine then " (you)" else "") .. (if view.host + 1 == i then " · host" else "")
		label("●  " .. text, { TextColor3 = Color3.fromHex(PLAYER_COLORS[(i - 1) % #PLAYER_COLORS + 1]), Parent = col, LayoutOrder = 10 + i })
	end
	if view.seat ~= nil and view.host == view.seat then
		button("Start the game", function()
			send({ t = "start" })
		end, { Parent = col, LayoutOrder = 30 })
	elseif view.seat == nil then
		label("This room is full, so you are watching.", { Parent = col, LayoutOrder = 30 })
	else
		label("Waiting for the host to start.", { TextColor3 = MUTED, Parent = col, LayoutOrder = 30 })
	end
	button("Leave", function()
		call("leave")
	end, { Parent = col, LayoutOrder = 31, BackgroundColor3 = MUTED })
	if state.error then
		label(state.error, { TextColor3 = BAD, Parent = col, LayoutOrder = 32 })
	end
end

-- One ring of squares, drawn into `area` between the scale offsets `inset` on each side.
local function drawRing(area: Frame, first: number, count: number, inset: number, cfo: any)
	local cells, w, h = Bridge.ring(count)
	local span = 1 - 2 * inset
	for i, cell in cells do
		local pos = first + i - 1 -- the website's square number
		local sq = state.board.squares[pos + 1]
		local tile = cfo.tiles[pos + 1] -- may be nil: JSON nulls leave holes
		local f = make("Frame", {
			Position = UDim2.fromScale(inset + span * cell.x / w, inset + span * cell.y / h),
			Size = UDim2.fromScale(span / w, span / h),
			BackgroundColor3 = CARD,
			BorderSizePixel = 0,
			Parent = area,
		}, { make("UIStroke", { Color = Color3.fromHex("#d7d4cc"), Thickness = 1 }) })
		if sq and sq.color then
			make("Frame", { Size = UDim2.new(1, 0, 0.18, 0), BackgroundColor3 = Color3.fromHex(sq.color), BorderSizePixel = 0, Parent = f })
		end
		if tile and tile.owner ~= nil then
			make("UIStroke", { Color = Color3.fromHex(PLAYER_COLORS[tile.owner % #PLAYER_COLORS + 1]), Thickness = 3, Parent = f })
		end
		local text = sq and sq.name or ""
		if tile and tile.zone then
			text ..= "\n" .. tile.zone:sub(1, 3):upper() .. (if tile.building then " ▲" else "")
		end
		label(text, { Size = UDim2.new(1, -2, 0.8, 0), Position = UDim2.new(0, 1, 0.2, 0), AutomaticSize = Enum.AutomaticSize.None, TextScaled = true, TextXAlignment = Enum.TextXAlignment.Center, TextYAlignment = Enum.TextYAlignment.Top, Parent = f })
		-- Tokens of the players standing here.
		local k = 0
		for j, p in cfo.players do
			if p.pos == pos and not p.out then
				make("Frame", { AnchorPoint = Vector2.new(0, 1), Position = UDim2.new(0.08 + 0.15 * k, 0, 0.95, 0), Size = UDim2.fromScale(0.22, 0.22), SizeConstraint = Enum.SizeConstraint.RelativeXX, BackgroundColor3 = Color3.fromHex(PLAYER_COLORS[(j - 1) % #PLAYER_COLORS + 1]), Parent = f }, { make("UICorner", { CornerRadius = UDim.new(1, 0) }) })
				k += 1
			end
		end
	end
end

local function renderMove(parent: Instance, move: any, order: number)
	local function go(value: number?)
		local msg = Bridge.actionFor(move, value)
		if not msg then
			state.error = "Enter a number above zero."
			render()
			return
		end
		if move.confirm and confirming ~= move.label then
			confirming = move.label
			render()
			return
		end
		confirming = nil
		send(msg)
	end
	local title = if confirming == move.label then "Tap again: " .. move.label else move.label
	if not move.input then
		button(title, function()
			go(nil)
		end, { Parent = parent, LayoutOrder = order, BackgroundColor3 = if confirming == move.label then BAD else ACCENT })
		return
	end
	local row = make("Frame", { BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 34), Parent = parent, LayoutOrder = order })
	local box = make("TextBox", { PlaceholderText = if move.input == "count" then "How many" else "Amount", Text = typed[move.label] or "", ClearTextOnFocus = false, Font = Enum.Font.Gotham, TextSize = 14, TextColor3 = INK, BackgroundColor3 = PAPER, Size = UDim2.new(0.32, -6, 1, 0), Parent = row }, { corner() })
	box:GetPropertyChangedSignal("Text"):Connect(function()
		typed[move.label] = box.Text
	end)
	button(title, function()
		go(tonumber((box.Text:gsub("[$,%s]", ""))))
	end, { Parent = row, Size = UDim2.new(0.68, 0, 1, 0), Position = UDim2.fromScale(0.32, 0), AutomaticSize = Enum.AutomaticSize.None, TextScaled = true })
end

local function renderGame(view: any)
	local cfo = view.game
	local area = make("Frame", { Size = UDim2.fromScale(0.64, 1), BackgroundTransparency = 1, Parent = root }, { make("UIAspectRatioConstraint", { AspectRatio = 1.7 }) })
	drawRing(area, 0, state.board.size, 0.01, cfo)
	if state.board.islandSize > 0 then
		drawRing(area, state.board.islandStart, state.board.islandSize, 0.27, cfo)
	end
	local dice = if cfo.dice then "Dice: " .. table.concat(cfo.dice, " + ") else ""
	label(dice .. (if cfo.year then "   Year " .. cfo.year else ""), { AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromScale(0.5, 0.5), Size = UDim2.fromScale(0.3, 0.06), AutomaticSize = Enum.AutomaticSize.None, TextXAlignment = Enum.TextXAlignment.Center, Font = Enum.Font.GothamMedium, Parent = area })

	local side = make("ScrollingFrame", { Position = UDim2.fromScale(0.65, 0), Size = UDim2.fromScale(0.35, 1), CanvasSize = UDim2.new(), AutomaticCanvasSize = Enum.AutomaticSize.Y, ScrollBarThickness = 6, BackgroundColor3 = CARD, BorderSizePixel = 0, Parent = root }, { make("UIPadding", { PaddingLeft = UDim.new(0, 12), PaddingRight = UDim.new(0, 16), PaddingTop = UDim.new(0, 12), PaddingBottom = UDim.new(0, 12) }) })
	local col = column({ Parent = side })
	local order = 0
	local function nextOrder()
		order += 1
		return order
	end
	label(Bridge.turnText(cfo, view.seat), { Font = Enum.Font.GothamBold, TextSize = 20, Parent = col, LayoutOrder = nextOrder() })
	if cfo.endReason then
		label(cfo.endReason, { Parent = col, LayoutOrder = nextOrder() })
	end
	if state.updateNeeded then
		label("The website has a newer CFO than this Roblox cfo understands. Some things may not work until the cfo is updated.", { TextColor3 = BAD, Parent = col, LayoutOrder = nextOrder() })
	end
	if state.error then
		label(state.error, { TextColor3 = BAD, Parent = col, LayoutOrder = nextOrder() })
	end

	for i, p in cfo.players do
		local mine = view.seat ~= nil and view.seat + 1 == i
		local line = p.name .. (if mine then " (you)" else "") .. (if p.out then " · out" else "")
			.. "\nCompany " .. (if p.cash ~= nil then Bridge.money(p.cash) else "?") .. " · Personal " .. Bridge.money(p.personalCash)
			.. (if p.value ~= nil then " · Value " .. Bridge.money(p.value) else "")
		label(line, { TextColor3 = Color3.fromHex(PLAYER_COLORS[(i - 1) % #PLAYER_COLORS + 1]):Lerp(INK, 0.45), TextSize = 13, Parent = col, LayoutOrder = nextOrder() })
		if mine and p.hand and #p.hand > 0 then
			label("Cards: " .. table.concat(p.hand, ", "), { TextColor3 = MUTED, TextSize = 13, Parent = col, LayoutOrder = nextOrder() })
		end
	end

	if cfo.phase == "over" then
		button("Play again", function()
			send({ t = "again" })
		end, { Parent = col, LayoutOrder = nextOrder() })
	end
	for _, group in Bridge.groupMoves(cfo.moves or {}) do
		label(group.title, { Font = Enum.Font.GothamBold, TextColor3 = MUTED, Parent = col, LayoutOrder = nextOrder() })
		for _, move in group.moves do
			renderMove(col, move, nextOrder())
		end
	end

	label("Log", { Font = Enum.Font.GothamBold, TextColor3 = MUTED, Parent = col, LayoutOrder = nextOrder() })
	for i = #cfo.log, 1, -1 do -- newest first
		label(cfo.log[i], { TextSize = 12, Parent = col, LayoutOrder = nextOrder() })
	end
	button("Leave the room", function()
		call("leave")
	end, { Parent = col, LayoutOrder = nextOrder(), BackgroundColor3 = MUTED })
end

function render()
	root:ClearAllChildren()
	local view = state.view
	if not state.code or not view then
		renderLobby()
	elseif view.status == "waiting" or not view.game then
		renderWaiting(view)
	else
		renderGame(view)
	end
end

stateEvent.OnClientEvent:Connect(function(msg)
	if msg.code then
		state.code = msg.code
		state.board = msg.board
		state.view = nil
	end
	if msg.updateNeeded then
		state.updateNeeded = true
	end
	if msg.error then
		state.error = msg.error
	end
	if msg.view then
		state.view = msg.view
		state.error = nil
	end
	render()
end)

render()
