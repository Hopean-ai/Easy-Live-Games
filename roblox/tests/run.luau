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
	eq(Bridge.cleanMessage({ t = "act", a = string.rep("x", 41) }), nil, "long string")
	eq(Bridge.cleanMessage("act"), nil, "not a table")
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
