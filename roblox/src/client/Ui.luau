-- The look every hub screen shares: the website's colours (public/cfo.css) and small builders for
-- labels, buttons, boxes and panels. Each game's screens (client/games) draw with these.
local Ui = {}

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


Ui.PLAYER_COLORS = PLAYER_COLORS
Ui.BG = BG
Ui.PANEL = PANEL
Ui.PANEL2 = PANEL2
Ui.LINE = LINE
Ui.FG = FG
Ui.MUTED = MUTED
Ui.ACCENT = ACCENT
Ui.BAD = BAD
Ui.WARN = WARN
Ui.STYLES = STYLES
Ui.make = make
Ui.corner = corner
Ui.stroke = stroke
Ui.pad = pad
Ui.merge = merge
Ui.label = label
Ui.heading = heading
Ui.small = small
Ui.button = button
Ui.chip = chip
Ui.column = column
Ui.row = row
Ui.card = card
Ui.pair = pair
Ui.textBox = textBox
Ui.playerColor = playerColor

return Ui
