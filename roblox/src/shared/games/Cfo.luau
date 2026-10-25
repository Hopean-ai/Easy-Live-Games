--!strict
-- CFO's helpers, shared by the hub's server and the CFO screens. Nothing here knows the CFO rules:
-- the rules live on the website's server (src/cfo/rules.js), which sends the board, the state and
-- the list of moves each player can make. That way a rule change on the web needs no Roblox update.
--
-- Every game in the hub has a module like this one in shared/games, giving its website id, the
-- bridge version it understands and how to clean a move (see roblox/README.md, "Adding a game").
-- This module requires nothing, so the Lune tests in roblox/tests can load it outside Roblox.

local Bridge = {}

-- The website's id for the game (src/games.js).
Bridge.ID = "cfo"

-- The newest website bridge this build understands (BRIDGE_VERSION in src/cfo/roblox.js). A newer
-- website sends a higher number; players are then told the Roblox game needs an update.
Bridge.SUPPORTED = 1

-- Where each group of moves is shown, in order.
Bridge.GROUPS = {
	{ id = "turn", title = "Your turn" },
	{ id = "property", title = "Property" },
	{ id = "company", title = "Company" },
	{ id = "money", title = "Money" },
	{ id = "market", title = "Other companies" },
	{ id = "cards", title = "Cards" },
	{ id = "deals", title = "Deals" },
	{ id = "game", title = "Game" },
}

-- "$1,234" or "-$56.50": whole dollars unless there are cents.
function Bridge.money(n: number?): string
	local v = n or 0
	local sign = if v < 0 then "-" else ""
	v = math.abs(v)
	local whole = math.floor(v)
	local cents = math.floor((v - whole) * 100 + 0.5)
	if cents == 100 then
		whole += 1
		cents = 0
	end
	local digits = tostring(whole)
	local out = digits:reverse():gsub("(%d%d%d)", "%1,"):reverse()
	if out:sub(1, 1) == "," then
		out = out:sub(2)
	end
	if cents > 0 then
		out ..= string.format(".%02d", cents)
	end
	return sign .. "$" .. out
end

export type Cell = { x: number, y: number }

-- Lays `count` squares around a rectangle, starting at the bottom-right corner and going
-- clockwise (left along the bottom, up the left side, along the top, down the right). Returns the
-- cells (0-based grid coordinates) and the grid's width and height. 62 squares make a 21 x 12 ring.
function Bridge.ring(count: number): ({ Cell }, number, number)
	local perimeter = count + (count % 2) -- an odd count leaves one cell empty
	local height = math.max(2, math.floor((perimeter + 4) / 6))
	local width = (perimeter + 4) / 2 - height
	local cells: { Cell } = {}
	local x, y = width - 1, height - 1
	local steps = { { -1, 0, width - 1 }, { 0, -1, height - 1 }, { 1, 0, width - 1 }, { 0, 1, height - 1 } }
	for _, step in steps do
		for _ = 1, step[3] do
			if #cells < count then
				table.insert(cells, { x = x, y = y })
			end
			x += step[1]
			y += step[2]
		end
	end
	return cells, width, height
end

-- The moves sent by the server, sorted into GROUPS. Unknown groups go last under "More", so a
-- new kind of move on the web still shows up.
function Bridge.groupMoves(moves: { any }): { { id: string, title: string, moves: { any } } }
	local byId: { [string]: { any } } = {}
	for _, m in moves do
		local id = if type(m.group) == "string" then m.group else "more"
		byId[id] = byId[id] or {}
		table.insert(byId[id], m)
	end
	local out = {}
	for _, g in Bridge.GROUPS do
		if byId[g.id] then
			table.insert(out, { id = g.id, title = g.title, moves = byId[g.id] })
			byId[g.id] = nil
		end
	end
	local rest = {}
	for _, list in byId do
		for _, m in list do
			table.insert(rest, m)
		end
	end
	if #rest > 0 then
		table.insert(out, { id = "more", title = "More", moves = rest })
	end
	return out
end

-- What the server forwards from a client: only the message types the website accepts, and only
-- plain fields, plus the `lines` of a journal entry. The website checks everything again; this
-- just keeps junk off the network.
local MESSAGE_TYPES = { start = true, again = true, act = true }
local MAX_FIELDS = 12
local MAX_LINES = 12

local function cleanNumber(v: any): boolean
	return type(v) == "number" and v == v and math.abs(v) <= 1e9
end

local function cleanLines(lines: any): { { any } }?
	if type(lines) ~= "table" or #lines == 0 or #lines > MAX_LINES then
		return nil
	end
	local out = {}
	local n = 0
	for i, line in lines do
		n += 1
		if type(i) ~= "number" or type(line) ~= "table" or #line ~= 2 then
			return nil
		end
		local acct, amount = line[1], line[2]
		if type(acct) ~= "string" or #acct > 24 or not cleanNumber(amount) then
			return nil
		end
		for k in line do
			if k ~= 1 and k ~= 2 then
				return nil
			end
		end
		out[i] = { acct, amount }
	end
	return if n == #lines then out else nil
end

function Bridge.cleanMessage(msg: any): { [string]: any }?
	if type(msg) ~= "table" or not MESSAGE_TYPES[msg.t] then
		return nil
	end
	local out: { [string]: any } = {}
	local n = 0
	for k, v in msg do
		if type(k) ~= "string" or #k > 20 then
			return nil
		end
		local kind = type(v)
		if k == "lines" then
			local lines = cleanLines(v)
			if not lines then
				return nil
			end
			v = lines
		elseif kind == "number" then
			if not cleanNumber(v) then
				return nil
			end
		elseif kind == "string" then
			if #v > 80 then
				return nil
			end
		elseif kind ~= "boolean" then
			return nil
		end
		out[k] = v
		n += 1
		if n > MAX_FIELDS then
			return nil
		end
	end
	if out.t == "act" and type(out.a) ~= "string" then
		return nil
	end
	return out
end

-- A journal entry being typed: each line has an account and the text typed as its debit and
-- credit. Returns where the plug goes, as the web page does it: whatever the typed amounts leave
-- unbalanced, on the other side, on the last line with nothing typed (keeping `prev` while that
-- line is still free), or on a new line (#lines + 1) when every line has an amount.
export type DraftLine = { acct: string?, debit: string, credit: string }
export type Plug = { line: number, side: "debit" | "credit", amount: number }

local function amountOf(text: string): number?
	local v = tonumber((text:gsub("[$,%s]", "")))
	return if v ~= nil and v == v and v >= 0 then v else nil
end
Bridge.amountOf = amountOf

local function free(line: DraftLine): boolean
	return line.debit == "" and line.credit == ""
end

function Bridge.plug(lines: { DraftLine }, prev: number?): Plug?
	local diff = 0
	for _, line in lines do
		diff += (amountOf(line.debit) or 0) - (amountOf(line.credit) or 0)
	end
	diff = math.floor(diff * 100 + 0.5) / 100
	if diff == 0 then
		return nil
	end
	local target = if prev and lines[prev] and free(lines[prev]) then prev else nil
	if not target then
		for i = #lines, 1, -1 do
			if free(lines[i]) then
				target = i
				break
			end
		end
	end
	return { line = target or #lines + 1, side = if diff > 0 then "credit" else "debit", amount = math.abs(diff) }
end

-- The lines to send for a draft, with the plug filled in: { account, debit minus credit }. Lines
-- with neither an account nor an amount are left out. Returns nil and a message when a line has
-- an amount but no account, or the reverse.
function Bridge.entryLines(lines: { DraftLine }, plug: Plug?): ({ { any } }?, string?)
	local out = {}
	for i, line in lines do
		local v = (amountOf(line.debit) or 0) - (amountOf(line.credit) or 0)
		if plug and plug.line == i then
			v += if plug.side == "debit" then plug.amount else -plug.amount
		end
		v = math.floor(v * 100 + 0.5) / 100
		if line.acct or v ~= 0 then
			if not line.acct then
				return nil, "Pick an account for every line."
			end
			if v == 0 then
				return nil, "Every line needs a debit or a credit."
			end
			table.insert(out, { line.acct, v })
		end
	end
	if plug and plug.line > #lines then
		return nil, "Add a line for the amount that balances the entry."
	end
	if #out == 0 then
		return nil, "An entry needs at least one line."
	end
	return out, nil
end

-- "Dr Cash $1,000, Cr Land $1,000" for a posted entry's lines.
function Bridge.entryText(lines: { { any } }, names: { [string]: string }): string
	local parts = {}
	for _, line in lines do
		local v = line[2]
		table.insert(parts, (if v > 0 then "Dr " else "Cr ") .. (names[line[1]] or line[1]) .. " " .. Bridge.money(math.abs(v)))
	end
	return table.concat(parts, ", ")
end

-- The action to send for a move, with a typed amount or count when the move needs one.
function Bridge.actionFor(move: any, typed: number?): { [string]: any }?
	local msg: { [string]: any } = { t = "act" }
	for k, v in move.action do
		msg[k] = v
	end
	if move.input then
		if typed == nil or typed ~= typed or typed <= 0 then
			return nil
		end
		local value = if move.input == "count" then math.floor(typed) else math.floor(typed * 100 + 0.5) / 100
		msg[move.input] = value * (move.sign or 1)
	end
	return msg
end

-- One line saying whose turn it is.
function Bridge.turnText(game: any, seat: number?): string
	if game.winner ~= nil then
		local w = game.players[game.winner + 1]
		return if w then w.name .. " wins!" else "Game over"
	end
	if game.phase == "over" then
		return "Game over"
	end
	if seat ~= nil and game.turn == seat then
		return "Your turn"
	end
	local p = game.players[game.turn + 1]
	return if p then p.name .. "'s turn" else ""
end

return Bridge
