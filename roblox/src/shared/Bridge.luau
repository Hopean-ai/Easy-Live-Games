--!strict
-- Pure helpers shared by the Roblox server and client. Nothing here knows the CFO rules: the rules
-- live on the website's server (src/cfo/rules.js), which sends the board, the state and the list
-- of moves each player can make. That way a rule change on the web needs no Roblox update.
--
-- This module requires nothing, so the Lune tests in roblox/tests can load it outside Roblox.

local Bridge = {}

-- The newest website bridge this build understands (BRIDGE_VERSION in src/cfo/roblox.js). A newer
-- website sends a higher number; players are then told the Roblox game needs an update.
Bridge.SUPPORTED = 1

Bridge.POLL_SECONDS = 2

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

function Bridge.updateNeeded(bridgeVersion: number?): boolean
	return (bridgeVersion or 0) > Bridge.SUPPORTED
end

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
-- plain fields. The website checks everything again; this just keeps junk off the network.
local MESSAGE_TYPES = { start = true, again = true, act = true }
local MAX_FIELDS = 12

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
		if kind == "number" then
			if v ~= v or math.abs(v) > 1e9 then
				return nil
			end
		elseif kind == "string" then
			if #v > 40 then
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
