-- Draws the Driftmail screens outside Roblox from what the website sends a Roblox player today
-- (scripts/roblox-fixture.mjs), and checks what each button asks the server for. Run from roblox/:
--   node ../scripts/roblox-fixture.mjs > tests/fixture.json && lune run tests/driftmail
local fs = require("@lune/fs")
local serde = require("@lune/serde")
local Bridge = require("../src/shared/games/Driftmail")
local Harness = require("./harness")

local fixture = serde.decode("json", fs.readFile("tests/fixture.json"))
local view = fixture.driftmail

local h = Harness.start({
	games = { "Cfo", "Driftmail" },
	invoke = function(kind, arg)
		if kind == "hello" then
			return { games = {
				{ id = "cfo", name = "CFO", blurb = "An accounting board game.", players = "2–6", minPlayers = 2, maxPlayers = 6 },
				{ id = "driftmail", name = "Driftmail", blurb = "Letters in bottles.", players = "Any number of", world = true },
			}, link = { linked = false } }
		elseif kind == "world" then
			assert(arg.game == "driftmail", "world requests name the game")
			assert(Bridge.cleanWorld(arg), "the server would forward " .. tostring(arg.op))
			return { view = view }
		end
		return {}
	end,
})
local has, press, last = h.has, h.press, h.last

assert(has("Play Driftmail") and has("One shared ocean"), "the picker lists Driftmail as a shared world")
press("Play Driftmail")
assert(last()[1] == "world" and last()[2].op == "state", "opening Driftmail asks for the island straight away")
assert(not has("Quick match") and not has("New room"), "no lobby for a world")
assert(has(Bridge.cap(view.clock.part) .. " on your island"), "the island clock shows")

-- The beach: a bottle on the sand, supplies and curios.
assert(#view.beach > 0, "the fixture has a bottle on the beach")
assert(has("on your " .. view.beach[1].shore .. " beach. Open it"), "the bottle on the sand shows")
assert(has("Supplies") and has(Bridge.cap(view.curios[1].name)), "supplies and curios show")
press("Open it")
assert(last()[2].op == "open" and last()[2].id == view.beach[1].id, "opening sends the bottle's id")

-- Letters: the shelf's text comes from the filtered texts.
press("Letters")
local letter = view.shelf[1]
local body = view.texts[letter.text]
assert(body, "the fixture's letter text is in texts")
assert(has(Bridge.firstLine(body)), "the shelf shows the letter")
assert(has(Bridge.firstLine(view.texts[view.sent[1].text])), "the sent list shows the bottle thrown")
press(Bridge.firstLine(body))
assert(has(body) and has("— " .. view.texts[letter.name]), "the letter and its signature show")

-- Writing back: a reply, with a direction and strength.
press("Write back")
assert(has("Answering the letter"), "a reply says what it answers")
h.type("Write to whoever finds this", "Hello across the water.")
press("Throw it to sea")
assert(h.has("Pick which way to throw it."), "no throw without a direction")
press("NE", true)
press("Hard", true)
press("Sign it with my name")
press("Fold in a page")
press("Throw it to sea")
local throw = last()[2]
assert(throw.op == "throw" and throw.dir == 1 and throw.strength == 0.95 and throw.signed == true, "the throw sends direction, strength and signature")
assert(throw.replyTo == letter.id, "and what it answers")
assert(throw.page == view.journal[1].id, "and the page folded in")
assert(Bridge.cleanWorld(throw).text == "Hello across the water.", "the letter text goes as written, for the server to filter")
assert(has("Your bottle bobs away to the north-east."), "the throw is told")

-- Fishing.
press("Fishing")
assert(has("Your catch") and has("Fish"), "the catch shows")
assert(has(view.kit.spots[1].sign), "the water at each spot shows")
press(view.kit.spots[1].name)
assert(last()[2].op == "cast" and last()[2].spot == view.kit.spots[1].id, "casting at a spot asks the server")

-- The island: gathering, the garden, building and making.
press("Island")
assert(has("Materials") and has("Garden"), "the island shows its materials and garden")
press("Clay")
assert(last()[2].op == "gather" and last()[2].what == "clay", "gathering asks the server")
press("Water the garden")
assert(last()[2].op == "water", "watering asks the server")
press("Build")
assert(has("Shack"), "blueprints show")
press("Build: Shack frame")
assert(last()[2].op == "build" and last()[2].what == "shack", "building asks the server")
press("Boil down fish glue")
assert(last()[2].op == "make" and last()[2].what == "glue", "glue is made on the server")

-- The journal: abilities and pages.
press("Journal")
assert(has(view.abilities[1].name), "abilities show")
press(view.journal[1].title)
assert(has(view.journal[1].text), "a page can be read")
press("Close the journal")

-- Checks on what the server forwards.
assert(Bridge.cleanWorld({ op = "throw", text = "   ", dir = 0, strength = 0.5 }) == nil, "an empty letter is refused")
assert(Bridge.cleanWorld({ op = "throw", text = "hi", dir = 8, strength = 0.5 }) == nil, "a direction must be a compass point")
assert(Bridge.cleanWorld({ op = "throw", text = string.rep("a", 601), dir = 0, strength = 0.5 }) == nil, "letters are at most 600 characters")
assert(Bridge.cleanWorld({ op = "craft", what = "boat" }) == nil, "only hooks and glue")
assert(Bridge.cleanWorld({ op = "gather", what = "gold" }) == nil, "only what grows inland")
assert(Bridge.cleanWorld({ op = "cast", spot = "the moon" }) == nil, "spots are plain words")
local r = Bridge.cleanWorld({ op = "reel", strike = 2, answers = { "left", "give", "none" } })
assert(r and r.strike == 2 and #r.answers == 3, "a reel goes through")
assert(Bridge.cleanWorld({ op = "reel", strike = 1, answers = { "jump" } }) == nil, "only real answers")
assert(Bridge.cleanWorld({ op = "build", what = "a b" }) == nil, "blueprint names are plain words")
assert(Bridge.cleanWorld({ op = "mark", id = 3, mark = "great" }) == nil, "kind, useful or rude")
assert(Bridge.cleanWorld({ op = "pass", id = 3, dir = 1, line = string.rep("a", 141) }) == nil, "an added line is short")
assert(Bridge.cleanWorld({ op = "throw", text = "hi", dir = 0, strength = 0.5, items = { { kind = "drawing", data = "ff" } } }) == nil, "no drawings from Roblox")
local t = Bridge.cleanWorld({ op = "throw", text = "hi", dir = 0, strength = 0.5, kind = "jar", items = { { kind = "curio", index = 0 }, { kind = "map" } }, wax = true })
assert(t and t.kind == "jar" and #t.items == 2 and t.wax == true, "a jar with a curio and a map goes through")
assert(Bridge.cleanWorld({ op = "open", id = 1.5 }) == nil, "bottle ids are whole numbers")
assert(Bridge.cleanWorld({ op = "delete" }) == nil, "unknown requests are refused")

press("All games")
assert(has("Play CFO"), "back to the picker")
print("driftmail ok")
