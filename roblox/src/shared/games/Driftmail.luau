--!strict
-- Driftmail's helpers, shared by the hub's server and the Driftmail screens. Driftmail is one shared
-- ocean on the website (src/driftmail/ocean.js), not rooms: the hub opens its screens straight
-- from the picker, and the server forwards each request to /api/roblox/world/driftmail. Everything
-- players wrote arrives in the view's `texts`, which the server filters before the client sees it.
--
-- This module requires nothing, so the Lune tests in roblox/tests can load it outside Roblox.

local Bridge = {}

-- The website's id for the game (src/games.js).
Bridge.ID = "driftmail"

-- The newest website bridge this build understands (BRIDGE_VERSION in src/driftmail/roblox.js).
Bridge.SUPPORTED = 1

-- One shared world rather than rooms: no lobby, quick match or room codes.
Bridge.WORLD = true

-- How often the open screens ask for the island again.
Bridge.POLL_SECONDS = 30

Bridge.MAX_LETTER = 600
Bridge.MAX_LINE = 140

-- What can be gathered inland once a tide, and how a letter can be marked.
Bridge.GATHER = { "leaves", "clay", "sand", "stones", "reeds", "berries" }
Bridge.GATHER_NAMES = { "Palm leaves", "Clay", "Sand", "Stones", "Wild reeds", "Wild berries" }

-- The fishing minigame: how a fish pulls, how to answer each pull, and the words for it.
Bridge.ANSWERS = { left = "right", right = "left", away = "give" }
Bridge.PULL_WORDS = { left = "It runs hard to the left!", right = "It runs hard to the right!", away = "It dives for the deep water!" }
Bridge.NIBBLE_SECONDS = 0.5
Bridge.BITE_SECONDS = 1.4
Bridge.PULL_SECONDS = 2.8
Bridge.MARKS = { "kind", "useful", "rude" }
Bridge.WAX_NAMES = { "red", "blue", "green", "violet", "amber", "black", "rose" }

Bridge.MATERIAL_NAMES = {
	driftwood = "Driftwood", rope = "Rope", clay = "Clay", sand = "Sand", stones = "Stones", leaves = "Palm leaves", reeds = "Reeds",
	berries = "Berries", bark = "Bark", wax = "Wax", oil = "Fish oil", scales = "Fish scales", jars = "Jars", shimmer = "Shimmering ink",
	traps = "Traps", bottles = "Bottles", corks = "Corks", paper = "Paper", ink = "Ink", fish = "Fish", bones = "Bones", glue = "Fish glue",
}

-- "4 driftwood, 2 rope", from a cost table, in a fixed order.
function Bridge.costWords(cost: { [string]: number }?): string
	local parts = {}
	for k, n in cost or {} do
		table.insert(parts, { k = k, text = n .. " " .. string.lower(Bridge.MATERIAL_NAMES[k] or k) })
	end
	table.sort(parts, function(a, b)
		return a.k < b.k
	end)
	local out = {}
	for _, p in parts do
		table.insert(out, p.text)
	end
	return table.concat(out, ", ")
end

-- Compass points, clockwise from north, as the website numbers them.
Bridge.DIRS = { "N", "NE", "E", "SE", "S", "SW", "W", "NW" }
Bridge.DIR_WORDS = { "north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west" }

-- How hard to throw, as the website's 0.1..1 strength.
Bridge.STRENGTHS = { { name = "Gently", value = 0.3 }, { name = "Firmly", value = 0.6 }, { name = "Hard", value = 0.95 } }

-- Room games forward moves with cleanMessage; Driftmail has none.
function Bridge.cleanMessage(_msg: any): any?
	return nil
end

-- A short id from the website's tables (a building, a recipe, a crop, a material).
local function word(v: any): boolean
	return type(v) == "string" and #v > 0 and #v <= 24 and v:match("^%a+$") ~= nil
end

local function int(v: any, lo: number, hi: number): number?
	if type(v) ~= "number" or v ~= math.floor(v) or v < lo or v > hi then
		return nil
	end
	return v
end

-- A request from the client, checked and copied before the server sends it on, or nil. The
-- letter text is returned as is: the server filters it before it goes anywhere.
function Bridge.cleanWorld(arg: any): { [string]: any }?
	if type(arg) ~= "table" then
		return nil
	end
	local op = arg.op
	if op == "state" or op == "water" or op == "spear" or op == "trap" or op == "traps" then
		return { op = op }
	elseif op == "fish" then
		return { op = op, bait = arg.bait == true }
	elseif op == "cast" then
		return if word(arg.spot) then { op = op, spot = arg.spot, bait = arg.bait == true } else nil
	elseif op == "reel" then
		local strike = int(arg.strike, -1, 20)
		local answers = {}
		if strike == nil or (arg.answers ~= nil and type(arg.answers) ~= "table") then
			return nil
		end
		for i, a in arg.answers or {} do
			if i > 10 or not (a == "left" or a == "right" or a == "give" or a == "none") then
				return nil
			end
			answers[i] = a
		end
		return { op = op, strike = strike, answers = answers }
	elseif op == "gather" then
		return if table.find(Bridge.GATHER, arg.what) then { op = op, what = arg.what } else nil
	elseif op == "build" or op == "make" then
		if not word(arg.what) then
			return nil
		end
		local pattern = if arg.pattern == nil then nil else int(arg.pattern, 0, 31)
		if arg.pattern ~= nil and pattern == nil then
			return nil
		end
		return { op = op, what = arg.what, pattern = pattern }
	elseif op == "plant" then
		local plot = int(arg.plot, 0, 3)
		return if plot and word(arg.crop) then { op = op, plot = plot, crop = arg.crop } else nil
	elseif op == "harvest" then
		local plot = int(arg.plot, 0, 3)
		return if plot then { op = op, plot = plot } else nil
	elseif op == "seal" then
		local glyph, wax = int(arg.glyph, 0, #Bridge.GLYPHS - 1), int(arg.wax, 0, #Bridge.WAX - 1)
		return if glyph and wax then { op = op, glyph = glyph, wax = wax } else nil
	elseif op == "snag" then
		return { op = op, keep = arg.keep == true }
	elseif op == "mark" then
		local id = int(arg.id, 1, 2 ^ 52)
		return if id and table.find(Bridge.MARKS, arg.mark) then { op = op, id = id, mark = arg.mark } else nil
	elseif op == "burn" then
		local id = int(arg.id, 1, 2 ^ 52)
		return if id then { op = op, id = id } else nil
	elseif op == "pass" then
		local id, dir = int(arg.id, 1, 2 ^ 52), int(arg.dir, 0, 7)
		local line = if type(arg.line) == "string" then (arg.line:match("^%s*(.-)%s*$") :: string) else ""
		if not id or not dir or utf8.len(line) == nil or (utf8.len(line) :: number) > Bridge.MAX_LINE then
			return nil
		end
		return { op = op, id = id, dir = dir, line = line, strength = 0.6 }
	elseif op == "open" then
		local id = int(arg.id, 1, 2 ^ 52)
		return if id then { op = op, id = id } else nil
	elseif op == "craft" then
		return if arg.what == "hook" or arg.what == "glue" then { op = op, what = arg.what } else nil
	elseif op == "throw" then
		local text = arg.text
		if type(text) ~= "string" then
			return nil
		end
		text = text:match("^%s*(.-)%s*$") :: string
		if #text == 0 or utf8.len(text) == nil or (utf8.len(text) :: number) > Bridge.MAX_LETTER then
			return nil
		end
		local dir = int(arg.dir, 0, 7)
		local strength = arg.strength
		if dir == nil or type(strength) ~= "number" or strength ~= strength or strength < 0.1 or strength > 1 then
			return nil
		end
		local page = arg.page
		if page ~= nil and (type(page) ~= "string" or #page > 40 or not page:match("^[%w%-]+$")) then
			return nil
		end
		local replyTo = if arg.replyTo == nil then nil else int(arg.replyTo, 1, 2 ^ 52)
		if arg.replyTo ~= nil and replyTo == nil then
			return nil
		end
		local kind = arg.kind or "bottle"
		if not word(kind) then
			return nil
		end
		local items = {}
		for i, it in (if type(arg.items) == "table" then arg.items else {}) do
			if i > 20 or type(it) ~= "table" then
				return nil
			end
			if it.kind == "curio" and int(it.index, 0, 999) then
				table.insert(items, { kind = "curio", index = it.index })
			elseif it.kind == "seeds" and word(it.crop) then
				table.insert(items, { kind = "seeds", crop = it.crop })
			elseif it.kind == "map" then
				table.insert(items, { kind = "map" })
			elseif it.kind == "materials" and type(it.what) == "table" then
				local what = {}
				for k, n in it.what do
					if not word(k) or not int(n, 1, 50) then
						return nil
					end
					what[k] = n
				end
				table.insert(items, { kind = "materials", what = what })
			else
				return nil
			end
		end
		local forge = if arg.forge == nil then nil else int(arg.forge, 1, 2 ^ 52)
		if arg.forge ~= nil and forge == nil then
			return nil
		end
		return {
			op = op, text = text, dir = dir, strength = strength, signed = arg.signed == true,
			glue = arg.glue == true, page = page, replyTo = replyTo, kind = kind, items = items,
			wax = arg.wax == true, stamp = arg.stamp == true, shimmer = arg.shimmer == true, forge = forge,
		}
	end
	return nil
end

-- A writer's hand, the same on every letter they send: one of a few hand-written fonts and an ink.
Bridge.FONTS = { "IndieFlower", "PatrickHand", "PermanentMarker", "AmaticSC", "SpecialElite", "Fondamento" }
Bridge.INKS = { "#1f2a44", "#2b2620", "#3a2a5a", "#173d33", "#5a2222", "#24364f", "#4a3b1c" }
Bridge.WAX = { "#8e2b2b", "#2b4f8e", "#2f6b3f", "#6b3f8e", "#8e6a2b", "#3a3a3a", "#8e2b62" }
Bridge.GLYPHS = { "✶", "☽", "⚓", "❀", "✦", "♆", "☀", "✿", "◈", "❖", "✺", "♠", "♣", "♥", "♦", "☘" }

function Bridge.hand(seed: number?): (string, string)
	local s = math.floor(seed or 0)
	return Bridge.FONTS[s % #Bridge.FONTS + 1], Bridge.INKS[(s // 7) % #Bridge.INKS + 1]
end

function Bridge.seal(seed: number?): (string, string)
	local s = math.floor(seed or 0)
	return Bridge.GLYPHS[s % #Bridge.GLYPHS + 1], Bridge.WAX[(s // 16) % #Bridge.WAX + 1]
end

-- "just now", "12 min ago", "3 h ago", "2 d ago", from two times in milliseconds.
function Bridge.ago(now: number, t: number?): string
	local m = math.floor(((now - (t or now)) / 60000) + 0.5)
	if m < 1 then
		return "just now"
	elseif m < 60 then
		return m .. " min ago"
	end
	local h = math.floor(m / 60 + 0.5)
	if h < 24 then
		return h .. " h ago"
	end
	return math.floor(h / 24 + 0.5) .. " d ago"
end

-- "within the hour" or "in about 3 hours", until a time in milliseconds.
function Bridge.untilText(now: number, t: number): string
	local m = math.floor((t - now) / 60000 + 0.5)
	if m < 60 then
		return "within the hour"
	end
	return "in about " .. math.floor(m / 60 + 0.5) .. " hours"
end

-- The first line of a letter, cut short for a list.
function Bridge.firstLine(text: string?): string
	local line = ((text or ""):match("^[^\n]*") or "") :: string
	if utf8.len(line) and (utf8.len(line) :: number) > 48 then
		local cut = utf8.offset(line, 47) or 47
		return line:sub(1, cut - 1):gsub("%s+$", "") .. "…"
	end
	return line
end

function Bridge.cap(s: string): string
	return s:sub(1, 1):upper() .. s:sub(2)
end

-- "a, b and c".
function Bridge.list(items: { string }): string
	if #items < 2 then
		return items[1] or ""
	end
	return table.concat(items, ", ", 1, #items - 1) .. " and " .. items[#items]
end

return Bridge
