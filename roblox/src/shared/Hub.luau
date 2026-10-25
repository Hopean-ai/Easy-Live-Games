--!strict
-- Pure helpers for the hub itself, shared by its server and client: what every game has in common.
-- Each game's own helpers are in shared/games (one module per game, named in src/games.js).
--
-- This module requires nothing, so the Lune tests in roblox/tests can load it outside Roblox.

local Hub = {}

Hub.POLL_SECONDS = 2

-- Whether the website speaks a newer bridge for a game than this build understands.
function Hub.updateNeeded(supported: number, bridgeVersion: number?): boolean
	return (bridgeVersion or 0) > supported
end

-- A room code as typed, or nil when it can't be one.
function Hub.roomCode(text: any): string?
	if type(text) ~= "string" or #text > 12 or not text:match("^%w%w%w%w+$") then
		return nil
	end
	return text:upper()
end

-- A game id from the client: short, lower-case letters and digits.
function Hub.gameId(id: any): string?
	if type(id) ~= "string" or #id > 20 or not id:match("^[%l%d]+$") then
		return nil
	end
	return id
end

-- The games the website offers on Roblox that this build has screens for, in the website's order.
function Hub.playable(listed: { any }?, have: { [string]: any }): { any }
	local out = {}
	for _, g in listed or {} do
		if type(g) == "table" and type(g.id) == "string" and have[g.id] then
			table.insert(out, g)
		end
	end
	return out
end

-- The rooms a linked account has going, newest first, kept to games this build has, at most `max`.
function Hub.rejoins(link: any, have: { [string]: any }, max: number): { { game: string, code: string } }
	local out = {}
	for _, g in (link and link.games) or {} do
		local id = g.game or "cfo" -- older websites listed only CFO rooms, without ids
		if have[id] and type(g.code) == "string" then
			table.insert(out, { game = id, code = g.code, updated = tonumber(g.updated) or 0 })
		end
	end
	table.sort(out, function(a: any, b: any)
		return a.updated > b.updated
	end)
	while #out > max do
		table.remove(out)
	end
	return out :: any
end

-- The quick-match line: how many are waiting, and how long until a game starts with them.
function Hub.queueText(q: any): string
	local text = "Finding players: " .. (q.waiting or 1) .. " of " .. (q.max or 6) .. " waiting."
	if q.startsIn then
		text ..= " Starting in " .. math.max(0, math.ceil(q.startsIn)) .. " s unless more join."
	end
	return text
end

return Hub
