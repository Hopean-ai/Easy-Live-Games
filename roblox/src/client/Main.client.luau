-- The CFO screens on Roblox, drawn to look and play like the web page: a lobby with quick match,
-- then the board, and tabs for the turn, the books, the players, the market and the log. Nothing
-- here knows the rules: the website sends the board, the state, every move this player can make
-- (with its label) and the forms for deals and plans, so web changes show up without an update.
local Players = game:GetService("Players")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local UserInputService = game:GetService("UserInputService")

local Bridge = require(ReplicatedStorage:WaitForChild("CfoShared"):WaitForChild("Bridge"))
local remotes = ReplicatedStorage:WaitForChild("CfoRemotes")
local requestFn: RemoteFunction = remotes:WaitForChild("Request")
local stateEvent: RemoteEvent = remotes:WaitForChild("State")

local player = Players.LocalPlayer

-- The web page's colours (public/cfo.css).
local PLAYER_COLORS = { "#5ad1a5", "#f0b429", "#7aa2ff", "#ff7a9c", "#c792ea", "#ff9f43" }
local BG = Color3.fromHex("#0e1116")
local PANEL = Color3.fromHex("#171b22")
local PANEL2 = Color3.fromHex("#1f2630")
local LINE = Color3.fromHex("#2a313c")
local FG = Color3.fromHex("#e8ecf1")
local MUTED = Color3.fromHex("#8b95a3")
local ACCENT = Color3.fromHex("#5ad1a5")
local BAD = Color3.fromHex("#ff7a7a")
local WARN = Color3.fromHex("#f0b429")

local function playerColor(i: number): Color3
	return Color3.fromHex(PLAYER_COLORS[(i - 1) % #PLAYER_COLORS + 1])
end

-- What the client knows: the room code, the fixed board, and the latest view from the server.
local state = { code = nil :: string?, board = nil :: any, view = nil :: any, error = nil :: string?, updateNeeded = false, queue = nil :: any, link = nil :: any }
-- What this player has open or typed, kept across redraws.
local ui = {
	tab = "turn",
	selected = nil :: number?, -- a square picked on the board
	form = nil :: string?, -- the open deal or plan form
	formValues = {} :: { [string]: { [string]: any } },
	editor = nil :: any, -- the journal entry being written
	picker = nil :: number?, -- the editor line choosing an account
	pickerSearch = "",
	archiveOpen = false,
	confirming = nil :: string?, -- a button waiting for a second tap
	typed = {} :: { [string]: string }, -- amounts typed into move boxes
}

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

local function stroke(color: Color3?, thickness: number?)
	return make("UIStroke", { Color = color or LINE, Thickness = thickness or 1, ApplyStrokeMode = Enum.ApplyStrokeMode.Border })
end

local function pad(px: number)
	return make("UIPadding", { PaddingLeft = UDim.new(0, px), PaddingRight = UDim.new(0, px), PaddingTop = UDim.new(0, px), PaddingBottom = UDim.new(0, px) })
end

local function merge(base: { [string]: any }, extra: { [string]: any }?): { [string]: any }
	for k, v in extra or {} do
		base[k] = v
	end
	return base
end

local function label(text: string, props: { [string]: any }?): TextLabel
	return make("TextLabel", merge({
		BackgroundTransparency = 1,
		Text = text,
		TextColor3 = FG,
		Font = Enum.Font.Gotham,
		TextSize = 14,
		TextWrapped = true,
		TextXAlignment = Enum.TextXAlignment.Left,
		AutomaticSize = Enum.AutomaticSize.Y,
		Size = UDim2.new(1, 0, 0, 0),
	}, props))
end

local function heading(text: string, props: { [string]: any }?): TextLabel
	return label(text, merge({ Font = Enum.Font.GothamBold, TextSize = 16 }, props))
end

local function small(text: string, props: { [string]: any }?): TextLabel
	return label(text, merge({ TextColor3 = MUTED, TextSize = 12 }, props))
end

-- Buttons come in the web page's kinds: primary (green), secondary (outlined), danger and link.
local STYLES = {
	primary = { BackgroundColor3 = ACCENT, TextColor3 = BG, BackgroundTransparency = 0 },
	secondary = { BackgroundColor3 = PANEL2, TextColor3 = FG, BackgroundTransparency = 0 },
	danger = { BackgroundColor3 = BAD, TextColor3 = BG, BackgroundTransparency = 0 },
	link = { BackgroundColor3 = PANEL, TextColor3 = ACCENT, BackgroundTransparency = 1 },
}

local function button(text: string, onClick: () -> (), props: { [string]: any }?, kind: string?): TextButton
	local style = STYLES[kind or "primary"]
	local b = make("TextButton", merge({
		Text = text,
		TextColor3 = style.TextColor3,
		BackgroundColor3 = style.BackgroundColor3,
		BackgroundTransparency = style.BackgroundTransparency,
		Font = Enum.Font.GothamMedium,
		TextSize = 14,
		TextWrapped = true,
		AutoButtonColor = true,
		AutomaticSize = Enum.AutomaticSize.Y,
		Size = UDim2.new(1, 0, 0, 30),
	}, props), { corner(), make("UIPadding", { PaddingLeft = UDim.new(0, 8), PaddingRight = UDim.new(0, 8), PaddingTop = UDim.new(0, 5), PaddingBottom = UDim.new(0, 5) }) })
	if kind == "secondary" then
		stroke().Parent = b
	end
	b.Activated:Connect(onClick)
	return b
end

-- A small button that sits in a row.
local function chip(text: string, onClick: () -> (), props: { [string]: any }?, kind: string?): TextButton
	return button(text, onClick, merge({ Size = UDim2.new(0, 0, 0, 26), AutomaticSize = Enum.AutomaticSize.XY, TextSize = 13, TextWrapped = false }, props), kind or "secondary")
end

local function column(props: { [string]: any }?, gap: number?): Frame
	return make("Frame", merge({ BackgroundTransparency = 1, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0) }, props), {
		make("UIListLayout", { Padding = UDim.new(0, gap or 6), SortOrder = Enum.SortOrder.LayoutOrder }),
	})
end

local function row(props: { [string]: any }?): Frame
	return make("Frame", merge({ BackgroundTransparency = 1, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0) }, props), {
		make("UIListLayout", { Padding = UDim.new(0, 6), FillDirection = Enum.FillDirection.Horizontal, Wraps = true, SortOrder = Enum.SortOrder.LayoutOrder, VerticalAlignment = Enum.VerticalAlignment.Center }),
	})
end

-- A card on the web page: a panel with a border.
local function card(props: { [string]: any }?): (Frame, Frame)
	local f = make("Frame", merge({ BackgroundColor3 = PANEL2, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0) }, props), { corner(8), stroke(), pad(10) })
	return f, column({ Parent = f })
end

-- One line of a statement: the name on the left, the amount on the right.
local function pair(parent: Instance, left: string, right: string, order: number, bold: boolean?)
	local f = make("Frame", { BackgroundTransparency = 1, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0), LayoutOrder = order, Parent = parent })
	local font = if bold then Enum.Font.GothamBold else Enum.Font.Gotham
	label(left, { Size = UDim2.new(0.62, 0, 0, 0), Font = font, TextSize = 13, Parent = f })
	label(right, { Size = UDim2.new(0.38, 0, 0, 0), Position = UDim2.fromScale(0.62, 0), Font = font, TextSize = 13, TextXAlignment = Enum.TextXAlignment.Right, Parent = f })
end

local function textBox(props: { [string]: any }): TextBox
	return make("TextBox", merge({
		Text = "",
		ClearTextOnFocus = false,
		Font = Enum.Font.Gotham,
		TextSize = 14,
		TextColor3 = FG,
		PlaceholderColor3 = MUTED,
		BackgroundColor3 = BG,
		TextXAlignment = Enum.TextXAlignment.Left,
		Size = UDim2.new(1, 0, 0, 30),
	}, props), { corner(), stroke(), make("UIPadding", { PaddingLeft = UDim.new(0, 8), PaddingRight = UDim.new(0, 8) }) })
end

local gui = make("ScreenGui", { Name = "Cfo", ResetOnSpawn = false, IgnoreGuiInset = true, ZIndexBehavior = Enum.ZIndexBehavior.Sibling, Parent = player:WaitForChild("PlayerGui") })
local root = make("Frame", { Size = UDim2.fromScale(1, 1), BackgroundColor3 = BG, BorderSizePixel = 0, Parent = gui })

local render: () -> ()

local function call(kind: string, arg: any?): any
	local ok, res = pcall(function()
		return requestFn:InvokeServer(kind, arg)
	end)
	state.error = if not ok then "Lost touch with the server." elseif res and res.error then res.error else nil
	if kind == "leave" and ok then
		state.code, state.view, state.board = nil, nil, nil
		ui.selected, ui.form, ui.editor, ui.picker = nil, nil, nil, nil
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
local function account(kind: string, arg: any?)
	local res = call(kind, arg)
	if res and res.link then
		state.link = res.link
		render()
	end
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

local function seatName(view: any, seat: number?): string
	local p = seat ~= nil and view.game and view.game.players[seat + 1]
	return if p then p.name else "?"
end

local function errorLine(parent: Instance, order: number)
	if state.error then
		label(state.error, { TextColor3 = BAD, Parent = parent, LayoutOrder = order })
	end
end

---------------------------------------------------------------------------------------------------
-- Lobby

local function centerCard(): Frame
	local box = make("Frame", { AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromScale(0.5, 0.5), Size = UDim2.new(0, 360, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, BackgroundColor3 = PANEL, Parent = root }, { corner(10), stroke(), pad(18) })
	return column({ Parent = box }, 8)
end

-- A linked player plays as their account: its games and admin role go with them. The code comes
-- from the account's page; this game never says where that is.
local function renderLink(col: Frame, order: number)
	local link = state.link
	if link and link.linked then
		heading(if link.admin then "Linked to your account (admin)" else "Linked to your account", { TextSize = 14, Parent = col, LayoutOrder = order })
		for i, g in link.games or {} do
			if i > 5 then
				break
			end
			button("Rejoin game " .. tostring(g.code), function()
				call("join", g.code)
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

-- Quick match, a new room, or a room code.
local function renderLobby()
	local col = centerCard()
	label("CFO", { Font = Enum.Font.GothamBold, TextSize = 30, TextColor3 = ACCENT, Parent = col, LayoutOrder = 1 })
	small("Run a company, keep the books, and outlast the other CFOs. Games are shared with players on the website.", { TextSize = 13, Parent = col, LayoutOrder = 2 })
	if state.queue then
		label(Bridge.queueText(state.queue), { Parent = col, LayoutOrder = 3 })
		button("Cancel", function()
			call("cancel")
		end, { Parent = col, LayoutOrder = 4 }, "secondary")
	else
		button("Quick match", function()
			state.queue = { waiting = 1, max = 6 }
			call("quick")
		end, { Parent = col, LayoutOrder = 3 })
		small("Plays the next game with whoever is looking, on Roblox or the web.", { Parent = col, LayoutOrder = 4 })
		button("New room", function()
			call("new")
		end, { Parent = col, LayoutOrder = 5 }, "secondary")
		local code = textBox({ PlaceholderText = "Room code", Font = Enum.Font.GothamMedium, TextSize = 16, Parent = col, LayoutOrder = 6 })
		button("Join", function()
			call("join", code.Text)
		end, { Parent = col, LayoutOrder = 7 }, "secondary")
		renderLink(col, 8)
	end
	errorLine(col, 20)
end

-- Waiting for the host to start.
local function renderWaiting(view: any)
	local col = centerCard()
	label("Room " .. (state.code or ""), { Font = Enum.Font.GothamBold, TextSize = 24, Parent = col, LayoutOrder = 1 })
	small("Share the room code. " .. (state.board and state.board.minPlayers or 2) .. " to " .. (state.board and state.board.maxPlayers or 6) .. " players.", { TextSize = 13, Parent = col, LayoutOrder = 2 })
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

---------------------------------------------------------------------------------------------------
-- Moves and forms

local function renderMove(parent: Instance, move: any, order: number)
	local function go(value: number?)
		local msg = Bridge.actionFor(move, value)
		if not msg then
			state.error = "Enter a number above zero."
			render()
			return
		end
		send(msg)
	end
	if not move.input then
		if move.confirm then
			confirmButton("move:" .. move.label, move.label, function()
				go(nil)
			end, { Parent = parent, LayoutOrder = order }, "secondary")
		else
			button(move.label, function()
				go(nil)
			end, { Parent = parent, LayoutOrder = order }, "secondary")
		end
		return
	end
	local line = make("Frame", { BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 32), Parent = parent, LayoutOrder = order })
	local box = textBox({ PlaceholderText = if move.input == "count" then "How many" else "Amount", Text = ui.typed[move.label] or "", Size = UDim2.new(0.3, -6, 1, 0), Parent = line })
	box:GetPropertyChangedSignal("Text"):Connect(function()
		ui.typed[move.label] = box.Text
	end)
	button(move.label, function()
		go(Bridge.amountOf(box.Text))
	end, { Parent = line, Size = UDim2.new(0.7, 0, 1, 0), Position = UDim2.fromScale(0.3, 0), AutomaticSize = Enum.AutomaticSize.None, TextScaled = true }, "secondary")
end

local function openForm(id: string, values: { [string]: any }?)
	ui.form = id
	ui.formValues[id] = values or ui.formValues[id] or {}
	ui.tab = "turn"
	render()
end

-- A deal or plan form, drawn from its description in FORMS (src/cfo/moves.js).
local function renderForm(parent: Instance, view: any, id: string, order: number)
	local form = state.board.forms[id]
	local values = ui.formValues[id]
	local _, col = card({ Parent = parent, LayoutOrder = order })
	heading(form.title, { Parent = col, LayoutOrder = 1 })
	small(form.help, { Parent = col, LayoutOrder = 2 })
	for i, field in form.fields do
		local o = 10 + i * 2
		small(field.label, { TextColor3 = FG, Font = Enum.Font.GothamMedium, Parent = col, LayoutOrder = o })
		if field.kind == "tile" then
			local pos = values[field.key]
			local sq = pos ~= nil and state.board.squares[pos + 1]
			label(if sq then sq.title else "Tap a square on the board.", { TextColor3 = if sq then FG else MUTED, TextSize = 13, Parent = col, LayoutOrder = o + 1 })
		elseif field.kind == "seat" then
			local r = row({ Parent = col, LayoutOrder = o + 1 })
			for j, p in view.game.players do
				if j - 1 ~= view.seat and not p.out then
					local on = values[field.key] == j - 1
					chip(p.name, function()
						values[field.key] = j - 1
						render()
					end, { Parent = r, LayoutOrder = j, TextColor3 = if on then BG else playerColor(j) }, if on then "primary" else "secondary")
				end
			end
		elseif field.kind == "choice" then
			local r = row({ Parent = col, LayoutOrder = o + 1 })
			for j, opt in field.options do
				local on = values[field.key] == opt.id
				chip(opt.name, function()
					values[field.key] = opt.id
					render()
				end, { Parent = r, LayoutOrder = j }, if on then "primary" else "secondary")
			end
		elseif field.kind == "toggle" then
			local on = values[field.key] == true
			chip(if on then "Yes" else "No", function()
				values[field.key] = not on
				render()
			end, { Parent = col, LayoutOrder = o + 1 }, if on then "primary" else "secondary")
		else -- money or count
			local box = textBox({ PlaceholderText = if field.kind == "money" then "Amount" else "How many", Text = values[field.key] or "", Parent = col, LayoutOrder = o + 1 })
			box:GetPropertyChangedSignal("Text"):Connect(function()
				values[field.key] = box.Text
			end)
		end
	end
	local r = row({ Parent = col, LayoutOrder = 100 })
	chip(form.submit, function()
		local msg: { [string]: any } = { t = "act", a = id }
		for _, field in form.fields do
			local v = values[field.key]
			if field.kind == "money" or field.kind == "count" then
				if v ~= nil and v ~= "" then
					local n = Bridge.amountOf(v)
					if n == nil then
						state.error = "Enter a number for " .. field.label:lower() .. "."
						render()
						return
					end
					msg[field.key] = if field.kind == "count" then math.floor(n) else math.floor(n * 100 + 0.5) / 100
				end
			elseif field.kind == "toggle" then
				msg[field.key] = v == true
			elseif v ~= nil then
				msg[field.key] = v
			end
		end
		if send(msg) then
			ui.form = nil
			ui.formValues[id] = nil
			render()
		end
	end, { Parent = r, LayoutOrder = 1 }, "primary")
	chip("Close", function()
		ui.form = nil
		render()
	end, { Parent = r, LayoutOrder = 2 }, "link")
end

---------------------------------------------------------------------------------------------------
-- The board

local function tagLabel(parent: Instance, text: string, color: string, position: UDim2)
	label(text, {
		AutomaticSize = Enum.AutomaticSize.None,
		Size = UDim2.fromScale(0.46, 0.2),
		Position = position,
		BackgroundTransparency = 0,
		BackgroundColor3 = Color3.fromHex(color),
		TextColor3 = BG,
		Font = Enum.Font.GothamBold,
		TextScaled = true,
		TextXAlignment = Enum.TextXAlignment.Center,
		Parent = parent,
	})
end

local function drawSquare(area: Frame, pos: number, sq: any, cfo: any)
	local grid = state.board.grid
	local tile = cfo.tiles[pos + 1] -- may be nil: JSON nulls leave holes
	local owned = tile and tile.owner ~= nil
	local selected = ui.selected == pos
	local f = make("Frame", {
		Position = UDim2.fromScale((sq.col - 1) / grid.cols, (sq.row - 1) / grid.rows),
		Size = UDim2.fromScale(1 / grid.cols, 1 / grid.rows),
		BackgroundColor3 = Color3.fromHex(sq.background),
		BorderSizePixel = 0,
		Parent = area,
	}, {
		stroke(if selected then FG elseif owned then playerColor(tile.owner + 1) else Color3.fromHex(sq.border), if selected or owned then 2 else 1),
	})
	local top = 0.04
	if sq.stripe then
		make("Frame", { Size = UDim2.fromScale(1, 0.16), BackgroundColor3 = Color3.fromHex(sq.stripe), BorderSizePixel = 0, Parent = f })
		top = 0.18
	end
	label(sq.title, { AutomaticSize = Enum.AutomaticSize.None, Size = UDim2.fromScale(0.92, 0.3), Position = UDim2.fromScale(0.04, top), TextScaled = true, Font = Enum.Font.GothamMedium, TextXAlignment = Enum.TextXAlignment.Center, Parent = f })
	local sub = if tile and tile.rent then Bridge.money(tile.rent) else sq.sub
	if sub ~= "" then
		label(sub, { AutomaticSize = Enum.AutomaticSize.None, Size = UDim2.fromScale(0.92, 0.18), Position = UDim2.fromScale(0.04, top + 0.3), TextScaled = true, TextColor3 = MUTED, TextXAlignment = Enum.TextXAlignment.Center, Parent = f })
	end
	if tile and tile.zone and state.board.zones[tile.zone] then
		local z = state.board.zones[tile.zone]
		tagLabel(f, z.mark, z.color, UDim2.fromScale(0.03, 0.56))
	end
	if tile and tile.rarity and state.board.rarities[tile.rarity] then
		local r = state.board.rarities[tile.rarity]
		tagLabel(f, r.name:sub(1, 4), r.color, UDim2.fromScale(0.51, 0.56))
	end
	-- Tokens of the players standing here.
	local k = 0
	for j, p in cfo.players do
		if p.pos == pos and not p.out then
			make("Frame", { AnchorPoint = Vector2.new(0, 1), Position = UDim2.new(0.06 + 0.15 * k, 0, 0.97, 0), Size = UDim2.fromScale(0.18, 0.18), SizeConstraint = Enum.SizeConstraint.RelativeXX, BackgroundColor3 = playerColor(j), Parent = f }, { make("UICorner", { CornerRadius = UDim.new(1, 0) }), stroke(BG, 1) })
			k += 1
		end
	end
	make("TextButton", { Name = "Square" .. pos, Text = "", BackgroundTransparency = 1, Size = UDim2.fromScale(1, 1), ZIndex = 2, Parent = f }).Activated:Connect(function()
		if ui.form and ui.formValues[ui.form] then
			for _, field in state.board.forms[ui.form].fields do
				if field.kind == "tile" then
					ui.formValues[ui.form][field.key] = pos
				end
			end
		end
		-- A second tap closes the square, except on your own lots, where it usually aims for the
		-- build moves.
		local mine = tile and tile.owner ~= nil and tile.owner == state.view.seat
		ui.selected = if ui.selected == pos and not mine then nil else pos
		render()
	end)
end

-- The middle of the board: the dice, the year, the card rows, and the square picked.
local function renderCenter(area: Frame, view: any)
	local cfo = view.game
	local grid = state.board.grid
	local mid = make("ScrollingFrame", {
		Position = UDim2.fromScale(1 / grid.cols + 0.005, 1 / grid.rows + 0.01),
		Size = UDim2.fromScale(12 / grid.cols - 0.01, (grid.rows - 2) / grid.rows - 0.02),
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		CanvasSize = UDim2.new(),
		AutomaticCanvasSize = Enum.AutomaticSize.Y,
		ScrollBarThickness = 4,
		Parent = area,
	}, { pad(6) })
	local col = column({ Parent = mid }, 4)
	local top = (if cfo.dice then "Dice " .. table.concat(cfo.dice, " + ") .. "   " else "") .. (if cfo.year then "Fiscal year " .. cfo.year else "") .. (if cfo.era then " · " .. cfo.era else "")
	label(top, { Font = Enum.Font.GothamMedium, Parent = col, LayoutOrder = 1 })
	local function cardRow(title: string, ids: { string }, names: any, left: number?, order: number)
		if #ids == 0 then
			return
		end
		local parts = {}
		for _, id in ids do
			local x = names[id]
			table.insert(parts, if x then x.name else tostring(id))
		end
		small(title .. ": " .. table.concat(parts, ", ") .. (if left then " (" .. left .. " left)" else ""), { Parent = col, LayoutOrder = order })
	end
	cardRow("Zoning cards", cfo.zoningRow or {}, state.board.zones, cfo.zoningLeft, 2)
	cardRow("PP&E cards", cfo.ppeRow or {}, state.board.rarities, cfo.ppeLeft, 3)

	local pos = ui.selected
	if pos == nil then
		small("Tap a square to see it.", { Parent = col, LayoutOrder = 10 })
		return
	end
	local sq = state.board.squares[pos + 1]
	local tile = cfo.tiles[pos + 1]
	local _, info = card({ Parent = col, LayoutOrder = 10, BackgroundColor3 = PANEL })
	heading(sq.title, { Parent = info, LayoutOrder = 1 })
	local facts = {}
	if sq.set then
		table.insert(facts, sq.set)
	end
	if sq.price then
		table.insert(facts, "Price " .. Bridge.money(sq.price))
	elseif sq.sub ~= "" then
		table.insert(facts, sq.sub)
	end
	if tile and tile.owner ~= nil then
		table.insert(facts, "Owned by " .. seatName(view, tile.owner) .. (if tile.owner == view.seat then " (you)" else ""))
	elseif tile then
		table.insert(facts, "For sale")
	end
	if tile and tile.zone and state.board.zones[tile.zone] then
		table.insert(facts, "Zoned " .. state.board.zones[tile.zone].name)
	end
	if tile and tile.rarity and state.board.rarities[tile.rarity] then
		table.insert(facts, state.board.rarities[tile.rarity].name .. " PP&E")
	end
	if tile and tile.rent then
		table.insert(facts, "Rent " .. Bridge.money(tile.rent))
	end
	small(table.concat(facts, " · "), { Parent = info, LayoutOrder = 2 })
	local order = 3
	for _, m in cfo.moves or {} do
		if m.action.pos == pos then
			order += 1
			renderMove(info, m, order)
		end
	end
	if tile and tile.owner ~= nil and table.find(cfo.forms or {}, "offer") then
		button(if tile.owner == view.seat then "Offer to sell it" else "Offer to buy it", function()
			local values = { pos = pos }
			if tile.owner ~= view.seat then
				values.target = tile.owner
			end
			openForm("offer", values)
		end, { Parent = info, LayoutOrder = 50 }, "secondary")
	end
end

local function renderBoard(area: Frame, view: any)
	for pos, sq in state.board.squares do
		drawSquare(area, pos - 1, sq, view.game)
	end
	renderCenter(area, view)
end

---------------------------------------------------------------------------------------------------
-- Tabs

local function renderTurn(col: Frame, view: any)
	local cfo = view.game
	local me = view.seat ~= nil and cfo.players[view.seat + 1]
	local order = 0
	local function nextOrder()
		order += 1
		return order
	end
	heading(Bridge.turnText(cfo, view.seat), { TextSize = 20, Parent = col, LayoutOrder = nextOrder() })
	if cfo.endReason then
		label(cfo.endReason, { Parent = col, LayoutOrder = nextOrder() })
	end
	if me and not me.out then
		small("Company cash " .. Bridge.money(me.cash) .. " · personal " .. Bridge.money(me.personalCash), { TextSize = 13, Parent = col, LayoutOrder = nextOrder() })
		if me.hand and #me.hand > 0 then
			small("Your cards: " .. table.concat(me.hand, ", "), { Parent = col, LayoutOrder = nextOrder() })
		end
	end
	if cfo.phase == "over" then
		button("Play again", function()
			send({ t = "again" })
		end, { Parent = col, LayoutOrder = nextOrder() })
	end
	-- Moves on one square (build, rezone, restructure) show under that square on the board, so
	-- the list here stays short.
	local general, onTiles = {}, 0
	for _, m in cfo.moves or {} do
		if m.action.pos ~= nil then
			onTiles += 1
		else
			table.insert(general, m)
		end
	end
	for _, group in Bridge.groupMoves(general) do
		small(group.title:upper(), { Font = Enum.Font.GothamBold, Parent = col, LayoutOrder = nextOrder() })
		for _, move in group.moves do
			renderMove(col, move, nextOrder())
		end
	end
	if onTiles > 0 then
		small("Tap one of your lots on the board to build on it or rezone it.", { Parent = col, LayoutOrder = nextOrder() })
	end
	if cfo.forms and #cfo.forms > 0 then
		small("DEALS AND PLANS", { Font = Enum.Font.GothamBold, Parent = col, LayoutOrder = nextOrder() })
		local r = row({ Parent = col, LayoutOrder = nextOrder() })
		for i, id in cfo.forms do
			local form = state.board.forms[id]
			if form then
				chip(form.title, function()
					if ui.form == id then
						ui.form = nil
						render()
					else
						openForm(id)
					end
				end, { Parent = r, LayoutOrder = i }, if ui.form == id then "primary" else "secondary")
			end
		end
		if ui.form and table.find(cfo.forms, ui.form) and state.board.forms[ui.form] then
			renderForm(col, view, ui.form, nextOrder())
		end
	end
end

local function accountNames(): { [string]: string }
	local names = {}
	for _, a in state.board.accounts do
		names[a.id] = a.name
	end
	return names
end

local function numberText(v: number): string
	return if v == math.floor(v) then string.format("%d", v) else string.format("%.2f", v)
end

local function startEditing(books: any, entry: any?, memo: string?, year: number?)
	local lines = {}
	for _, l in (if entry then entry.lines else { {}, {} }) do
		local v = l[2] or 0
		table.insert(lines, { acct = l[1], debit = if v > 0 then numberText(v) else "", credit = if v < 0 then numberText(-v) else "" })
	end
	local years = books.openYears
	local waiting = false
	for _, d in books.docs do
		if d.year == years[1] and not d.archived then
			waiting = true
		end
	end
	local default = if entry then entry.year elseif year and table.find(years, year) then year elseif waiting then years[1] else years[#years]
	ui.editor = { id = if entry then entry.id else "new", year = default, memo = if entry then entry.memo or "" else (memo or ""):sub(1, 80), lines = lines, plugAt = nil, error = nil }
	ui.tab = "books"
	render()
end

-- The journal entry editor. Typing only updates the plug and totals in place, so the box being
-- typed in keeps its cursor; everything else redraws when a button is pressed.
local function renderEditor(parent: Instance, books: any, order: number)
	local ed = ui.editor
	local names = accountNames()
	local _, col = card({ Parent = parent, LayoutOrder = order, BackgroundColor3 = PANEL })
	heading(if ed.id == "new" then "New journal entry" else "Change this entry", { TextSize = 14, Parent = col, LayoutOrder = 1 })
	if ed.memo ~= "" then
		small("For: " .. ed.memo, { Parent = col, LayoutOrder = 2 })
	end
	local years = books.openYears
	if #years > 1 then
		local r = row({ Parent = col, LayoutOrder = 3 })
		for i, y in years do
			chip("Fiscal year " .. y, function()
				ed.year = y
				render()
			end, { Parent = r, LayoutOrder = i }, if ed.year == y then "primary" else "secondary")
		end
	else
		small("Fiscal year " .. years[1], { Parent = col, LayoutOrder = 3 })
	end
	local head = make("Frame", { BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 16), Parent = col, LayoutOrder = 4 })
	small("Account", { Size = UDim2.new(0.44, 0, 1, 0), Parent = head })
	small("Debit", { Size = UDim2.new(0.24, 0, 1, 0), Position = UDim2.fromScale(0.45, 0), Parent = head })
	small("Credit", { Size = UDim2.new(0.24, 0, 1, 0), Position = UDim2.fromScale(0.7, 0), Parent = head })

	local boxes = {}
	local totals = small("", { Parent = col, LayoutOrder = 60 })
	local function refresh()
		local p = Bridge.plug(ed.lines, ed.plugAt)
		ed.plugAt = p and p.line
		local dr, cr = 0, 0
		for i, b in boxes do
			local line = ed.lines[i]
			dr += Bridge.amountOf(line.debit) or 0
			cr += Bridge.amountOf(line.credit) or 0
			local plugDr = p ~= nil and p.line == i and p.side == "debit"
			local plugCr = p ~= nil and p.line == i and p.side == "credit"
			b.dr.PlaceholderText = if plugDr then numberText(p.amount) else "Debit"
			b.cr.PlaceholderText = if plugCr then numberText(p.amount) else "Credit"
			b.dr.PlaceholderColor3 = if plugDr then ACCENT else MUTED
			b.cr.PlaceholderColor3 = if plugCr then ACCENT else MUTED
		end
		if p then
			if p.side == "debit" then
				dr += p.amount
			else
				cr += p.amount
			end
		end
		totals.Text = "Debits " .. Bridge.money(dr) .. ", credits " .. Bridge.money(cr) .. "."
			.. (if p and p.line > #ed.lines then " Add a line for the " .. Bridge.money(p.amount) .. " that balances it." elseif p then " The balancing amount is in green." else "")
	end
	for i, line in ed.lines do
		local r = make("Frame", { BackgroundTransparency = 1, Size = UDim2.new(1, 0, 0, 30), Parent = col, LayoutOrder = 10 + i })
		button(if line.acct then names[line.acct] or line.acct else "Account…", function()
			ui.picker = i
			ui.pickerSearch = ""
			render()
		end, { Parent = r, Size = UDim2.new(0.44, 0, 1, 0), AutomaticSize = Enum.AutomaticSize.None, TextSize = 12, TextTruncate = Enum.TextTruncate.AtEnd, TextWrapped = false, TextXAlignment = Enum.TextXAlignment.Left, TextColor3 = if line.acct then FG else MUTED }, "secondary")
		local dr = textBox({ Text = line.debit, Size = UDim2.new(0.24, -2, 1, 0), Position = UDim2.fromScale(0.45, 0), TextSize = 13, Parent = r })
		local cr = textBox({ Text = line.credit, Size = UDim2.new(0.24, -2, 1, 0), Position = UDim2.fromScale(0.7, 0), TextSize = 13, Parent = r })
		boxes[i] = { dr = dr, cr = cr }
		-- Typing in one column of a line clears the other, as on the web page.
		dr:GetPropertyChangedSignal("Text"):Connect(function()
			line.debit = dr.Text
			if dr.Text ~= "" and cr.Text ~= "" then
				cr.Text = ""
			end
			refresh()
		end)
		cr:GetPropertyChangedSignal("Text"):Connect(function()
			line.credit = cr.Text
			if cr.Text ~= "" and dr.Text ~= "" then
				dr.Text = ""
			end
			refresh()
		end)
		button("×", function()
			table.remove(ed.lines, i)
			render()
		end, { Parent = r, Size = UDim2.new(0.05, 0, 1, 0), Position = UDim2.fromScale(0.95, 0), AutomaticSize = Enum.AutomaticSize.None }, "link")
	end
	refresh()
	local r = row({ Parent = col, LayoutOrder = 70 })
	chip("Add a line", function()
		if #ed.lines < 12 then
			table.insert(ed.lines, { acct = nil, debit = "", credit = "" })
		end
		render()
	end, { Parent = r, LayoutOrder = 1 })
	chip(if ed.id == "new" then "Post entry" else "Save entry", function()
		local lines, err = Bridge.entryLines(ed.lines, Bridge.plug(ed.lines, ed.plugAt))
		if not lines then
			ed.error = err
			render()
			return
		end
		ed.error = nil
		local msg: { [string]: any } = { t = "act", a = "entry", year = ed.year, lines = lines }
		if ed.memo ~= "" then
			msg.memo = ed.memo
		end
		if ed.id ~= "new" then
			msg.entry = ed.id
		end
		if send(msg) then
			ui.editor = nil
			render()
		end
	end, { Parent = r, LayoutOrder = 2 }, "primary")
	chip("Cancel", function()
		ui.editor = nil
		render()
	end, { Parent = r, LayoutOrder = 3 }, "link")
	if ed.error then
		label(ed.error, { TextColor3 = BAD, TextSize = 13, Parent = col, LayoutOrder = 80 })
	end
end

local function renderStatements(parent: Instance, books: any, order: number)
	local preview = books.preview or { income = {}, balance = {} }
	local _, col = card({ Parent = parent, LayoutOrder = order, BackgroundColor3 = PANEL })
	heading("Fiscal year " .. books.fyeDue .. " is over: review and submit your statements", { TextSize = 14, Parent = col, LayoutOrder = 1 })
	small("These are built from the journal entries you dated to fiscal year " .. books.fyeDue .. ", so a mistake in an entry shows up here too. You can post, fix or delete entries until you submit. Anything not submitted by your next fiscal year end is submitted as it stands.", { Parent = col, LayoutOrder = 2 })
	local open = 0
	for _, d in books.docs do
		if d.year <= books.fyeDue and not d.archived then
			open += 1
		end
	end
	if open > 0 then
		label(open .. " document" .. (if open > 1 then "s" else "") .. " from fiscal year " .. books.fyeDue .. " still in your inbox. Anything missing from your entries counts as a misstatement.", { TextColor3 = WARN, TextSize = 13, Parent = col, LayoutOrder = 3 })
	end
	local o = 10
	for _, part in { { "Income statement", state.board.income, preview.income }, { "Balance sheet", state.board.balance, preview.balance } } do
		o += 1
		small(part[1]:upper(), { Font = Enum.Font.GothamBold, Parent = col, LayoutOrder = o })
		for _, f in part[2] do
			o += 1
			pair(col, f.name, Bridge.money(part[3][f.id] or 0), o, f.total)
		end
	end
	button("Submit statements", function()
		send({ t = "act", a = "statements" })
	end, { Parent = col, LayoutOrder = 500 })
end

local function renderBooks(col: Frame, view: any)
	local cfo = view.game
	local books = cfo.books
	if cfo.easyBooks or not books then
		label(if view.seat == nil then "Watchers don't see anyone's books." else "This game keeps the books for you.", { TextColor3 = MUTED, Parent = col, LayoutOrder = 1 })
		return
	end
	local names = accountNames()
	local order = 0
	local function nextOrder()
		order += 1
		return order
	end
	if books.check then
		label(books.check.head, { TextColor3 = if books.check.errors > 0 then WARN else ACCENT, TextSize = 13, Parent = col, LayoutOrder = nextOrder() })
		for _, line in books.check.lines do
			small(line, { Parent = col, LayoutOrder = nextOrder() })
		end
	end
	if books.fyeDue and not books.outsourced then
		renderStatements(col, books, nextOrder())
	end
	local fee = Bridge.money(state.board.bookkeeperFee or 0)
	if books.outsourced then
		small("A bookkeeper posts your entries and files your statements for " .. fee .. " per document, billed at each fiscal year end. Clean-books bonuses go to people who keep their own books.", { Parent = col, LayoutOrder = nextOrder() })
		chip("Keep my own books", function()
			send({ t = "act", a = "outsource", on = false })
		end, { Parent = col, LayoutOrder = nextOrder() })
		return
	end
	small("Not an accountant? A bookkeeper posts every entry and files your statements correctly for " .. fee .. " per document, billed at each fiscal year end, but you give up the clean-books bonus.", { Parent = col, LayoutOrder = nextOrder() })
	chip("Hire a bookkeeper", function()
		send({ t = "act", a = "outsource", on = true })
	end, { Parent = col, LayoutOrder = nextOrder() })

	-- The documents: a pile to work through, newest first. Archiving only marks one as done.
	local inbox, archived = {}, {}
	for i = #books.docs, 1, -1 do
		local d = books.docs[i]
		table.insert(if d.archived then archived else inbox, d)
	end
	local head = row({ Parent = col, LayoutOrder = nextOrder() })
	heading("Documents (" .. #inbox .. " in the inbox)", { Size = UDim2.new(0, 0, 0, 0), AutomaticSize = Enum.AutomaticSize.XY, TextSize = 15, Parent = head, LayoutOrder = 1 })
	if #inbox > 1 then
		chip("Archive all", function()
			send({ t = "act", a = "archive" })
		end, { Parent = head, LayoutOrder = 2 }, "link")
	end
	if #books.docs == 0 then
		small("No documents yet.", { Parent = col, LayoutOrder = nextOrder() })
	end
	local function doc(d: any)
		local _, c = card({ Parent = col, LayoutOrder = nextOrder(), BackgroundColor3 = if d.archived then PANEL else PANEL2 })
		label(d.text, { TextSize = 13, TextColor3 = if d.archived then MUTED else FG, Parent = c, LayoutOrder = 1 })
		local r = row({ Parent = c, LayoutOrder = 2 })
		small("Year " .. d.year, { Size = UDim2.new(0, 0, 0, 0), AutomaticSize = Enum.AutomaticSize.XY, Parent = r, LayoutOrder = 1 })
		if not d.archived then
			chip("Write entry", function()
				startEditing(books, nil, d.text, d.year)
			end, { Parent = r, LayoutOrder = 2 })
		end
		chip(if d.archived then "Back to inbox" else "Archive", function()
			send({ t = "act", a = "archive", doc = d.id, on = not d.archived })
		end, { Parent = r, LayoutOrder = 3 }, if d.archived then "link" else "secondary")
	end
	for _, d in inbox do
		doc(d)
	end
	if #archived > 0 then
		chip((if ui.archiveOpen then "Hide the archive (" else "Show the archive (") .. #archived .. ")", function()
			ui.archiveOpen = not ui.archiveOpen
			render()
		end, { Parent = col, LayoutOrder = nextOrder() }, "link")
		if ui.archiveOpen then
			for _, d in archived do
				doc(d)
			end
		end
	end

	-- The journal, by fiscal year, newest first.
	if ui.editor and ui.editor.id ~= "new" then
		local still = false
		for _, e in books.entries do
			if e.id == ui.editor.id then
				still = true
			end
		end
		if not still then
			ui.editor = nil
		end
	end
	local jhead = row({ Parent = col, LayoutOrder = nextOrder() })
	heading("Journal", { Size = UDim2.new(0, 0, 0, 0), AutomaticSize = Enum.AutomaticSize.XY, TextSize = 15, Parent = jhead, LayoutOrder = 1 })
	chip("New entry", function()
		if ui.editor and ui.editor.id == "new" then
			ui.editor = nil
			render()
		else
			startEditing(books, nil)
		end
	end, { Parent = jhead, LayoutOrder = 2 })
	if ui.editor and ui.editor.id == "new" then
		renderEditor(col, books, nextOrder())
	end
	for yi = #books.openYears, 1, -1 do
		local year = books.openYears[yi]
		local list = {}
		for i = #books.entries, 1, -1 do
			if books.entries[i].year == year then
				table.insert(list, books.entries[i])
			end
		end
		small("Fiscal year " .. year .. (if year == books.fyeDue then ", statements due" else ", under way") .. ": " .. #list .. " entr" .. (if #list == 1 then "y" else "ies"), { Font = Enum.Font.GothamMedium, Parent = col, LayoutOrder = nextOrder() })
		for _, e in list do
			local _, c = card({ Parent = col, LayoutOrder = nextOrder() })
			label(if e.memo ~= "" then e.memo else "Journal entry", { TextSize = 13, Parent = c, LayoutOrder = 1 })
			small(Bridge.entryText(e.lines, names), { Parent = c, LayoutOrder = 2 })
			local r = row({ Parent = c, LayoutOrder = 3 })
			chip("Edit", function()
				if ui.editor and ui.editor.id == e.id then
					ui.editor = nil
					render()
				else
					startEditing(books, e)
				end
			end, { Parent = r, LayoutOrder = 1 }, "link")
			confirmButton("unpost:" .. e.id, "Delete", function()
				send({ t = "act", a = "unpost", entry = e.id })
			end, { Parent = r, LayoutOrder = 2, Size = UDim2.new(0, 0, 0, 26), AutomaticSize = Enum.AutomaticSize.XY, TextSize = 13, TextWrapped = false }, "link")
			if ui.editor and ui.editor.id == e.id then
				renderEditor(col, books, nextOrder())
			end
		end
	end
end

local function renderPlayers(col: Frame, view: any)
	local cfo = view.game
	for i, p in cfo.players do
		local mine = view.seat ~= nil and view.seat + 1 == i
		local _, c = card({ Parent = col, LayoutOrder = i })
		local flags = (if mine then " (you)" else "") .. (if p.out then " · out" else "") .. (if p.skip then " · sitting out" else "") .. (if cfo.turn + 1 == i and cfo.phase ~= "over" then " · playing" else "")
		label("●  " .. p.name .. flags, { Font = Enum.Font.GothamBold, TextColor3 = playerColor(i), Parent = c, LayoutOrder = 1 })
		pair(c, "Company cash", if p.cash ~= nil then Bridge.money(p.cash) else "?", 2)
		pair(c, "Personal cash", Bridge.money(p.personalCash), 3)
		if p.portfolio ~= nil then
			pair(c, "Personal assets", Bridge.money(p.portfolio), 4)
		end
		if p.netWorth ~= nil then
			pair(c, "Net worth", Bridge.money(p.netWorth), 5)
		end
		if p.value ~= nil then
			pair(c, "Company value", Bridge.money(p.value), 6)
		end
		local sq = state.board.squares[p.pos + 1]
		small((if sq then "On " .. sq.title else "") .. " · " .. (p.years or 0) .. " fiscal year" .. (if p.years == 1 then "" else "s") .. " done" .. (if p.profile then " · " .. p.profile else ""), { Parent = c, LayoutOrder = 7 })
	end
end

local function renderMarket(col: Frame, view: any)
	local cfo = view.game
	heading("Share prices", { TextSize = 15, Parent = col, LayoutOrder = 1 })
	local any = false
	for i, p in cfo.players do
		if p.isPublic and not p.out then
			any = true
			local _, c = card({ Parent = col, LayoutOrder = 1 + i })
			label("●  " .. p.name, { Font = Enum.Font.GothamBold, TextColor3 = playerColor(i), Parent = c, LayoutOrder = 1 })
			pair(c, "Share price", Bridge.money(p.sharePrice), 2)
			if p.totalShares then
				pair(c, "Shares", tostring(p.totalShares), 3)
			end
			pair(c, "You own", tostring(p.myShares or 0), 4)
		end
	end
	if not any then
		small("No company has gone public yet.", { Parent = col, LayoutOrder = 2 })
	end
	heading("Cards on offer", { TextSize = 15, Parent = col, LayoutOrder = 20 })
	local o = 20
	for _, id in cfo.zoningRow or {} do
		local z = state.board.zones[id]
		o += 1
		pair(col, "Zoning: " .. (if z then z.name else tostring(id)), "", o)
	end
	for _, id in cfo.ppeRow or {} do
		local r = state.board.rarities[id]
		o += 1
		pair(col, "PP&E: " .. (if r then r.name else tostring(id)), if r and r.price then Bridge.money(r.price) else "", o)
	end
	small((cfo.zoningLeft or 0) .. " zoning cards and " .. (cfo.ppeLeft or 0) .. " PP&E cards left in the decks.", { Parent = col, LayoutOrder = o + 1 })
end

local function renderLog(col: Frame, view: any)
	local log = view.game.log
	for i = #log, 1, -1 do -- newest first
		label(log[i], { TextSize = 13, TextColor3 = if i == #log then FG else MUTED, Parent = col, LayoutOrder = #log - i + 1 })
	end
end

local TABS = {
	{ id = "turn", title = "Turn", draw = renderTurn },
	{ id = "books", title = "Books", draw = renderBooks },
	{ id = "players", title = "Players", draw = renderPlayers },
	{ id = "market", title = "Market", draw = renderMarket },
	{ id = "log", title = "Log", draw = renderLog },
}

-- Picking an account for a journal line: every account, narrowed by what is typed.
local function renderPicker()
	local names = state.board.accounts
	local back = make("TextButton", { Text = "", AutoButtonColor = false, BackgroundColor3 = Color3.new(0, 0, 0), BackgroundTransparency = 0.4, Size = UDim2.fromScale(1, 1), ZIndex = 5, Parent = root })
	back.Activated:Connect(function()
		ui.picker = nil
		render()
	end)
	local box = make("Frame", { AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromScale(0.5, 0.5), Size = UDim2.new(0, 380, 0.8, 0), BackgroundColor3 = PANEL, ZIndex = 6, Parent = root }, { corner(10), stroke(), pad(12) })
	heading("Pick an account", { Parent = box, ZIndex = 6, Size = UDim2.new(1, 0, 0, 20), AutomaticSize = Enum.AutomaticSize.None })
	local search = textBox({ PlaceholderText = "Search", Text = ui.pickerSearch, Position = UDim2.new(0, 0, 0, 26), ZIndex = 6, Parent = box })
	local list = make("ScrollingFrame", { Position = UDim2.new(0, 0, 0, 64), Size = UDim2.new(1, 0, 1, -64), CanvasSize = UDim2.new(), AutomaticCanvasSize = Enum.AutomaticSize.Y, ScrollBarThickness = 6, BackgroundTransparency = 1, BorderSizePixel = 0, ZIndex = 6, Parent = box })
	local function fill()
		list:ClearAllChildren()
		local col = column({ Parent = list, Size = UDim2.new(1, -10, 0, 0) }, 4)
		local q = ui.pickerSearch:lower()
		for i, a in names do
			if q == "" or a.name:lower():find(q, 1, true) then
				button(a.name, function()
					local line = ui.editor and ui.editor.lines[ui.picker]
					if line then
						line.acct = a.id
					end
					ui.picker = nil
					render()
				end, { Parent = col, LayoutOrder = i, ZIndex = 6, TextXAlignment = Enum.TextXAlignment.Left }, "secondary")
			end
		end
	end
	search:GetPropertyChangedSignal("Text"):Connect(function()
		ui.pickerSearch = search.Text
		fill()
	end)
	fill()
end

local function renderGame(view: any)
	local cfo = view.game
	-- The top bar: the room, whose turn it is, and the way out.
	local bar = make("Frame", { Size = UDim2.new(1, 0, 0, 44), BackgroundColor3 = PANEL, BorderSizePixel = 0, Parent = root }, { stroke(), pad(8) })
	local barRow = row({ Parent = bar, Size = UDim2.fromScale(1, 1), AutomaticSize = Enum.AutomaticSize.None })
	label("CFO", { Font = Enum.Font.GothamBold, TextSize = 20, TextColor3 = ACCENT, Size = UDim2.new(0, 0, 0, 0), AutomaticSize = Enum.AutomaticSize.XY, Parent = barRow, LayoutOrder = 1 })
	small("Room " .. (state.code or ""), { TextSize = 13, Size = UDim2.new(0, 0, 0, 0), AutomaticSize = Enum.AutomaticSize.XY, Parent = barRow, LayoutOrder = 2 })
	label(Bridge.turnText(cfo, view.seat), { Font = Enum.Font.GothamMedium, Size = UDim2.new(0, 0, 0, 0), AutomaticSize = Enum.AutomaticSize.XY, Parent = barRow, LayoutOrder = 3 })
	confirmButton("leave", "Leave the room", function()
		call("leave")
	end, { Parent = barRow, LayoutOrder = 4, Size = UDim2.new(0, 0, 0, 26), AutomaticSize = Enum.AutomaticSize.XY, TextSize = 13, TextWrapped = false }, "secondary")

	-- The board on the left, kept to its shape.
	local holder = make("Frame", { Position = UDim2.new(0, 8, 0, 52), Size = UDim2.new(0.63, -12, 1, -60), BackgroundTransparency = 1, Parent = root })
	local area = make("Frame", { AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.fromScale(0.5, 0.5), Size = UDim2.fromScale(1, 1), BackgroundColor3 = PANEL, BorderSizePixel = 0, Parent = holder }, {
		make("UIAspectRatioConstraint", { AspectRatio = state.board.grid.cols / state.board.grid.rows }),
	})
	renderBoard(area, view)

	-- The tabs on the right.
	local side = make("Frame", { Position = UDim2.new(0.63, 0, 0, 52), Size = UDim2.new(0.37, -8, 1, -60), BackgroundColor3 = PANEL, Parent = root }, { corner(8), stroke() })
	local tabs = make("Frame", { Size = UDim2.new(1, -12, 0, 30), Position = UDim2.new(0, 6, 0, 6), BackgroundTransparency = 1, Parent = side }, {
		make("UIListLayout", { FillDirection = Enum.FillDirection.Horizontal, Padding = UDim.new(0, 4), SortOrder = Enum.SortOrder.LayoutOrder }),
	})
	local books = cfo.books
	local due = books and books.fyeDue and not books.outsourced
	local inbox = 0
	if books and not books.outsourced then
		for _, d in books.docs do
			if not d.archived then
				inbox += 1
			end
		end
	end
	for i, t in TABS do
		local title = t.title
		if t.id == "books" and (due or inbox > 0) then
			title ..= if due then " !" else " " .. inbox
		end
		button(title, function()
			ui.tab = t.id
			render()
		end, { Parent = tabs, LayoutOrder = i, Size = UDim2.new(1 / #TABS, -4, 1, 0), AutomaticSize = Enum.AutomaticSize.None, TextSize = 13, TextWrapped = false }, if ui.tab == t.id then "primary" else "secondary")
	end
	local scroll = make("ScrollingFrame", { Position = UDim2.new(0, 0, 0, 40), Size = UDim2.new(1, 0, 1, -40), CanvasSize = UDim2.new(), AutomaticCanvasSize = Enum.AutomaticSize.Y, ScrollBarThickness = 6, BackgroundTransparency = 1, BorderSizePixel = 0, Parent = side }, {
		make("UIPadding", { PaddingLeft = UDim.new(0, 10), PaddingRight = UDim.new(0, 14), PaddingTop = UDim.new(0, 6), PaddingBottom = UDim.new(0, 12) }),
	})
	local outer = column({ Parent = scroll }, 8)
	if state.updateNeeded then
		label("The website has a newer CFO than this Roblox game understands. Some things may not work until the game is updated.", { TextColor3 = BAD, TextSize = 13, Parent = outer, LayoutOrder = 1 })
	end
	errorLine(outer, 2)
	local col = column({ Parent = outer, LayoutOrder = 3 }, 6)
	for _, t in TABS do
		if t.id == ui.tab then
			t.draw(col, view)
		end
	end
	if ui.picker and ui.editor then
		renderPicker()
	end
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
	if not state.code or not view then
		renderLobby()
	elseif view.status == "waiting" or not view.game then
		renderWaiting(view)
	else
		renderGame(view)
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
		state.code = msg.code
		state.board = msg.board
		state.view = nil
		state.queue = nil
		ui.selected, ui.form, ui.editor, ui.picker, ui.tab = nil, nil, nil, nil, "turn"
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
		-- Just bought the square you're on: pick it, so its build moves show beside it.
		local before = state.view and state.view.game
		local after = msg.view.game
		local seat = msg.view.seat
		if before and after and seat ~= nil and before.phase == "buy" and before.turn == seat and after.turn == seat and after.phase == "act" then
			local me = after.players[seat + 1]
			local tile = me and after.tiles[me.pos + 1]
			if tile and tile.owner == seat then
				ui.selected = me.pos
			end
		end
		state.view = msg.view
		state.error = nil
	end
	render()
end)

render()
task.spawn(account, "account")
