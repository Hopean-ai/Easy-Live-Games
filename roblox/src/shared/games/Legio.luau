--!strict
-- Legio's helpers, shared by the hub's server and the Legio screens. Legio is played alone against
-- the dice (src/legio/rules.js on the website), with one leaderboard for everyone: the hub opens its
-- screens straight from the picker, like a world, and the server forwards each request to
-- /api/roblox/world/legio. Everything in a career is the game's own words, so nothing comes back
-- in `texts` for the filter.
--
-- This module requires nothing, so the Lune tests in roblox/tests can load it outside Roblox.

local Bridge = {}

-- The website's id for the game (src/games.js).
Bridge.ID = "legio"

-- The newest website bridge this build understands (BRIDGE_VERSION in src/legio/roblox.js).
Bridge.SUPPORTED = 1

-- No lobby, quick match or room codes: the hub treats it like a world.
Bridge.WORLD = true

-- Room games forward moves with cleanMessage; Legio has none.
function Bridge.cleanMessage(_msg: any): any?
	return nil
end

local function int(v: any, lo: number, hi: number): number?
	if type(v) ~= "number" or v ~= math.floor(v) or v < lo or v > hi then
		return nil
	end
	return v
end

-- A request from the client, checked and copied before the server sends it on, or nil: the career
-- (`state`), a fresh one (`enlist`), or answer `i` (0-based) to the card shown at `turn`.
function Bridge.cleanWorld(arg: any): { [string]: any }?
	if type(arg) ~= "table" then
		return nil
	end
	local op = arg.op
	if op == "state" or op == "enlist" then
		return { op = op }
	elseif op == "choose" then
		local i, turn = int(arg.i, 0, 31), int(arg.turn, 0, 2 ^ 31)
		return if i and turn then { op = op, i = i, turn = turn } else nil
	end
	return nil
end

-- "Summer 241" for a line of the log.
function Bridge.when(entry: any): string
	return (if entry.half == 1 then "Winter " else "Summer ") .. tostring(entry.year)
end

-- "3 years" or "1 year".
function Bridge.years(n: number): string
	return n .. (if n == 1 then " year" else " years")
end

-- The stats a career shows, in the website's order. Milites (your soldiers' love) only matters once
-- you command men.
Bridge.STATS = {
	{ key = "virtus", name = "Virtus", gloss = "courage, and being seen to have it" },
	{ key = "gratia", name = "Gratia", gloss = "favour with the men who promote you" },
	{ key = "litterae", name = "Litterae", gloss = "reading, writing and accounts" },
	{ key = "milites", name = "Milites", gloss = "your soldiers' love", officer = true },
}

return Bridge
