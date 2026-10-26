-- Talks to the website's Roblox routes (src/router.js). Every call returns the decoded reply, or nil
-- and a message to show the player.
local HttpService = game:GetService("HttpService")
local Config = require(script.Parent.Config)

local Api = {}

local key: any = nil
local function getKey()
	if key == nil then
		local ok, secret = pcall(function()
			return HttpService:GetSecret(Config.secretName)
		end)
		if not ok then
			warn("Hub: no Roblox secret named " .. Config.secretName .. " (" .. tostring(secret) .. ")")
			return nil
		end
		key = secret
	end
	return key
end

local function request(method: string, path: string, body: any?): (any?, string?)
	local headers: { [string]: any } = { ["Content-Type"] = "application/json" }
	if body ~= nil then
		local k = getKey()
		if k == nil then
			return nil, "This game isn't connected to the website yet."
		end
		headers["X-Roblox-Key"] = k
	end
	local ok, res = pcall(function()
		return HttpService:RequestAsync({
			Url = Config.baseUrl .. path,
			Method = method,
			Headers = headers,
			Body = if body ~= nil then HttpService:JSONEncode(body) else nil,
		})
	end)
	if not ok then
		warn("Hub: request failed: " .. tostring(res))
		return nil, "Can't reach the website right now."
	end
	local decoded = nil
	pcall(function()
		decoded = HttpService:JSONDecode(res.Body)
	end)
	if not res.Success then
		return nil, if decoded and decoded.error then decoded.error else "The website said no (" .. res.StatusCode .. ")."
	end
	return decoded, nil
end

function Api.newRoom(): (string?, string?)
	local res, err = request("GET", "/api/new-room")
	return res and res.code, err
end

-- The games the website offers on Roblox: { games = { { id, name, blurb, players, minPlayers, maxPlayers } } }.
function Api.games(): (any?, string?)
	return request("POST", "/api/roblox/games", {})
end

-- A room of one game. op is "join", "leave", "act" or "poll"; for CFO see cleanRobloxRequest in
-- src/cfo/roblox.js. Every game's room answers the same four.
function Api.room(gameId: string, code: string, body: { [string]: any }): (any?, string?)
	return request("POST", "/api/roblox/" .. gameId .. "/" .. code, body)
end

-- A game that is one shared world (Driftmail): body is { op, userId, name, ... }, and the reply is
-- that player's view of it (src/driftmail/roblox.js).
function Api.world(gameId: string, body: { [string]: any }): (any?, string?)
	return request("POST", "/api/roblox/world/" .. gameId, body)
end

-- Quick match, in the same queue as web players. op is "join", "poll" or "leave"; the reply is
-- { queued = { waiting, max, startsAt? } }, { matched = { room, players } } or { left = true }.
function Api.match(gameId: string, userId: string, op: string): (any?, string?)
	return request("POST", "/api/roblox/match/" .. gameId, { op = op, userId = userId })
end

-- A player's link to an account on the website. op is "status", "redeem" (with code) or "unlink";
-- the reply is { linked, admin, games = { { game, code, updated } } }, with every game's rooms. It
-- never names the account.
function Api.link(userId: string, op: string, name: string?, code: string?): (any?, string?)
	return request("POST", "/api/roblox/link", { op = op, userId = userId, name = name, code = code })
end

return Api
