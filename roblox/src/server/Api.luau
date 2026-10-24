-- Talks to the website's Roblox route (src/cfo/roblox.js). Every call returns the decoded reply, or
-- nil and a message to show the player.
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
			warn("CFO: no Roblox secret named " .. Config.secretName .. " (" .. tostring(secret) .. ")")
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
		warn("CFO: request failed: " .. tostring(res))
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

-- op is "join", "leave", "act" or "poll"; see cleanRobloxRequest in src/cfo/roblox.js.
function Api.room(code: string, body: { [string]: any }): (any?, string?)
	return request("POST", "/api/roblox/cfo/" .. code, body)
end

return Api
