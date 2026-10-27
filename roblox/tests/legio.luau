-- Draws the Legio screens outside Roblox from what the website sends a Roblox player today
-- (scripts/roblox-fixture.mjs), and checks what each button asks the server for. Run from roblox/:
--   node ../scripts/roblox-fixture.mjs > tests/fixture.json && lune run tests/legio
local fs = require("@lune/fs")
local serde = require("@lune/serde")
local Bridge = require("../src/shared/games/Legio")
local Harness = require("./harness")

local fixture = serde.decode("json", fs.readFile("tests/fixture.json"))
local view = fixture.legio
local run = view.run

local h = Harness.start({
	games = { "Driftmail", "Legio" },
	invoke = function(kind, arg)
		if kind == "hello" then
			return { games = {
				{ id = "driftmail", name = "Driftmail", blurb = "Letters in bottles.", players = "Any number of", world = true },
				{ id = "legio", name = "Legio", blurb = "Climb from recruit to emperor.", players = "1", world = true, solo = true },
			}, link = { linked = false } }
		elseif kind == "world" then
			assert(arg.game == "legio", "world requests name the game")
			assert(Bridge.cleanWorld(arg), "the server would forward " .. tostring(arg.op))
			return { view = view }
		end
		return {}
	end,
})
local has, press, last = h.has, h.press, h.last

assert(has("Play Legio") and has("Single player"), "the picker lists Legio as a single-player game")
assert(not has("1 players"), "not as a table of one")
press("Play Legio")
assert(last()[1] == "world" and last()[2].op == "state", "opening Legio asks for the career straight away")
assert(not has("Quick match") and not has("New room"), "no lobby")

-- The card in front, and its choices.
assert(has(run.card.title) and has(run.card.text), "the card shows")
assert(has(run.name .. " · " .. run.ranks[run.rank + 1].name), "the soldier and his rank show")
local second = run.card.choices[2]
press(second.label)
local sent = last()[2]
assert(sent.op == "choose" and sent.i == 1 and sent.turn == run.turn, "a choice sends its 0-based index and the turn")
assert(has(run.log[#run.log].text), "the newest line of the log shows")

-- Standing: the stats and the ladder.
press("Standing")
assert(has("Virtus") and has("Health") and has(run.legion), "stats and the legion show")
assert(not has("Milites") or run.officer, "milites only once an officer")
assert(has(run.ranks[#run.ranks].name), "the whole ladder shows")

-- The leaderboard: soldiers' names, never accounts.
press("Leaderboard")
assert(has(view.leaderboard[1].name .. " (you)"), "your own careers are marked")
assert(has(view.leaderboard[2].name) and not has("miles"), "other players show by their soldier, not their account")
assert(has(view.leaderboard[1].fate), "how each career ended shows")

-- Giving up asks twice.
press("Give up this career")
assert(last()[2].op ~= "enlist", "the first tap only arms it")
press("Tap again")
assert(last()[2].op == "enlist", "the second tap enlists afresh")

-- Checks on what the server forwards.
assert(Bridge.cleanWorld({ op = "choose", i = -1, turn = 3 }) == nil, "no negative choices")
assert(Bridge.cleanWorld({ op = "choose", i = 1.5, turn = 3 }) == nil, "choices are whole numbers")
assert(Bridge.cleanWorld({ op = "choose", i = 1 }) == nil, "an answer names its turn")
assert(Bridge.cleanWorld({ op = "promote" }) == nil, "unknown requests are refused")
assert(Bridge.cleanWorld({ op = "enlist", extra = 1 }).extra == nil, "only the known fields go on")

press("All games")
assert(has("Play Driftmail"), "back to the picker")
print("legio ok")
