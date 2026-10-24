-- Unit tests for the parts of the Roblox game that run outside Roblox. Run from roblox/:
--   lune run tests/run
local Bridge = require("../src/shared/Bridge")

local passed, failed = 0, 0
local function test(name: string, fn: () -> ())
	local ok, err = pcall(fn)
	if ok then
		passed += 1
	else
		failed += 1
		print("FAIL " .. name .. ": " .. tostring(err))
	end
end
local function eq(a: any, b: any, what: string?)
	if a ~= b then
		error(`{what or "value"}: expected {tostring(b)}, got {tostring(a)}`, 2)
	end
end

test("money", function()
	eq(Bridge.money(0), "$0")
	eq(Bridge.money(1234), "$1,234")
	eq(Bridge.money(1234567.5), "$1,234,567.50")
	eq(Bridge.money(-56.5), "-$56.50")
	eq(Bridge.money(999.999), "$1,000")
	eq(Bridge.money(100), "$100")
end)

test("ring layouts cover the board once, around the edge", function()
	for _, count in { 62, 24, 7, 40 } do
		local cells, w, h = Bridge.ring(count)
		eq(#cells, count, "cells for " .. count)
		local seen = {}
		for i, c in cells do
			local key = c.x .. "," .. c.y
			assert(not seen[key], "cell used twice: " .. key)
			seen[key] = true
			assert(c.x == 0 or c.y == 0 or c.x == w - 1 or c.y == h - 1, "cell inside the ring")
			if i > 1 then
				local p = cells[i - 1]
				eq(math.abs(p.x - c.x) + math.abs(p.y - c.y), 1, "step size")
			end
		end
	end
	local _, w, h = Bridge.ring(62)
	eq(w, 22, "width")
	eq(h, 11, "height")
end)

test("moves are grouped in order, unknown groups last", function()
	local groups = Bridge.groupMoves({
		{ id = 1, group = "money" },
		{ id = 2, group = "turn" },
		{ id = 3, group = "brand-new" },
		{ id = 4, group = "turn" },
	})
	eq(#groups, 3)
	eq(groups[1].id, "turn")
	eq(#groups[1].moves, 2)
	eq(groups[2].id, "money")
	eq(groups[3].id, "more")
end)

test("only plain website messages are forwarded", function()
	assert(Bridge.cleanMessage({ t = "act", a = "roll" }))
	assert(Bridge.cleanMessage({ t = "start" }))
	eq(Bridge.cleanMessage({ t = "option" }), nil, "option")
	eq(Bridge.cleanMessage({ t = "act" }), nil, "no action")
	eq(Bridge.cleanMessage({ t = "act", a = "x", nested = {} }), nil, "table field")
	eq(Bridge.cleanMessage({ t = "act", a = "x", amount = 0 / 0 }), nil, "NaN")
	eq(Bridge.cleanMessage({ t = "act", a = string.rep("x", 81) }), nil, "long string")
	assert(Bridge.cleanMessage({ t = "act", a = "entry", memo = string.rep("x", 80) }), "an 80-letter memo")
	eq(Bridge.cleanMessage("act"), nil, "not a table")
end)

test("journal entry lines are forwarded, and nothing else in tables", function()
	local m = Bridge.cleanMessage({ t = "act", a = "entry", year = 1, lines = { { "cash", 100 }, { "land", -100 } } })
	eq(m and #m.lines, 2)
	eq(m and m.lines[2][1], "land")
	eq(Bridge.cleanMessage({ t = "act", a = "entry", lines = {} }), nil, "no lines")
	eq(Bridge.cleanMessage({ t = "act", a = "entry", lines = { { "cash" } } }), nil, "no amount")
	eq(Bridge.cleanMessage({ t = "act", a = "entry", lines = { { "cash", 1, 2 } } }), nil, "extra value")
	eq(Bridge.cleanMessage({ t = "act", a = "entry", lines = { { "cash", 0 / 0 } } }), nil, "NaN amount")
	eq(Bridge.cleanMessage({ t = "act", a = "entry", lines = { { {}, 1 } } }), nil, "table account")
	eq(Bridge.cleanMessage({ t = "act", a = "entry", lines = { x = { "cash", 1 } } }), nil, "keyed lines")
	local many = {}
	for i = 1, 13 do
		many[i] = { "cash", i }
	end
	eq(Bridge.cleanMessage({ t = "act", a = "entry", lines = many }), nil, "too many lines")
end)

test("the plug balances an entry on the last free line", function()
	local lines = { { acct = "land", debit = "1,000", credit = "" }, { acct = nil, debit = "", credit = "" } }
	local p = Bridge.plug(lines)
	eq(p and p.line, 2)
	eq(p and p.side, "credit")
	eq(p and p.amount, 1000)
	eq(Bridge.entryLines(lines, p), nil, "the plug line needs an account")
	lines[2].acct = "cash"
	local out = Bridge.entryLines(lines, p)
	eq(out and out[1][2], 1000)
	eq(out and out[2][2], -1000)
	eq(out and out[2][1], "cash")
	-- An extra free line: the plug stays where it was.
	table.insert(lines, { acct = nil, debit = "", credit = "" })
	eq(Bridge.plug(lines, 2).line, 2)
	eq(Bridge.plug(lines).line, 3)
	-- Every line typed and unbalanced: the plug wants a new line.
	local full = { { acct = "land", debit = "5", credit = "" }, { acct = "cash", debit = "", credit = "3" } }
	eq(Bridge.plug(full).line, 3)
	eq(Bridge.plug(full).amount, 2)
	local _, err = Bridge.entryLines(full, Bridge.plug(full))
	assert(err, "an unbalanced entry with no free line")
	full[2].credit = "5"
	eq(Bridge.plug(full), nil, "balanced")
	eq(#Bridge.entryLines(full, nil), 2)
	eq(Bridge.entryText({ { "land", 5 }, { "cash", -5 } }, { land = "Land", cash = "Cash" }), "Dr Land $5, Cr Cash $5")
end)

test("queue text", function()
	eq(Bridge.queueText({ waiting = 1, max = 6 }), "Finding players: 1 of 6 waiting.")
	eq(Bridge.queueText({ waiting = 2, max = 6, startsIn = 9.2 }), "Finding players: 2 of 6 waiting. Starting in 10 s unless more join.")
end)

test("typed amounts and counts", function()
	local m = Bridge.actionFor({ action = { a = "borrow" }, input = "amount" }, 1234.567)
	eq(m and m.amount, 1234.57)
	eq(m and m.t, "act")
	local sell = Bridge.actionFor({ action = { a = "trade", target = 1 }, input = "count", sign = -1 }, 3.7)
	eq(sell and sell.count, -3)
	eq(sell and sell.target, 1)
	eq(Bridge.actionFor({ action = { a = "pay" }, input = "amount" }, nil), nil, "missing amount")
	eq(Bridge.actionFor({ action = { a = "pay" }, input = "amount" }, -5), nil, "negative")
	local roll = Bridge.actionFor({ action = { a = "roll", steps = 3 } })
	eq(roll and roll.steps, 3)
end)

test("bridge versions", function()
	eq(Bridge.updateNeeded(Bridge.SUPPORTED), false)
	eq(Bridge.updateNeeded(Bridge.SUPPORTED + 1), true)
	eq(Bridge.updateNeeded(nil), false)
end)

test("turn text", function()
	local game = { turn = 1, phase = "roll", players = { { name = "Ann" }, { name = "Rob" } } }
	eq(Bridge.turnText(game, 1), "Your turn")
	eq(Bridge.turnText(game, 0), "Rob's turn")
	game.winner = 0
	eq(Bridge.turnText(game, 1), "Ann wins!")
end)

print(`{passed} passed, {failed} failed`)
if failed > 0 then
	error("tests failed")
end
