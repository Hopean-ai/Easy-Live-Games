-- Roblox's text filter, for games whose players write to each other (Driftmail's letters). Roblox
-- requires every piece of player-written text a game shows to pass through TextService, wherever it
-- was written. What a Roblox player writes is filtered before it leaves for the website; what comes
-- back (from anyone) is filtered again for the player reading it.
local TextService = game:GetService("TextService")

local Filter = {}

local UNSHOWN = "(This could not be shown.)"

-- What a player wrote, filtered for everyone, or nil when the filter couldn't be reached.
function Filter.outgoing(player: Player, text: string): string?
	local ok, result = pcall(function()
		local r = TextService:FilterStringAsync(text, player.UserId, Enum.TextFilterContext.PublicChat)
		return r:GetNonChatStringForBroadcastAsync()
	end)
	if not ok then
		warn("Hub: text filter failed: " .. tostring(result))
		return nil
	end
	return result
end

-- Filtered text by "<userId>:<key>". A key always names the same text (see src/driftmail/roblox.js),
-- so each one is filtered once per reader.
local cache: { [string]: string } = {}
local cached = 0
local MAX_CACHED = 20000

-- Filters every entry of `texts` for `player` to read, in parallel, and returns the filtered map.
function Filter.incoming(player: Player, texts: { [string]: string }?): { [string]: string }
	local out = {}
	local pending = 0
	local done = Instance.new("BindableEvent")
	for key, text in texts or {} do
		local id = player.UserId .. ":" .. key
		if cache[id] then
			out[key] = cache[id]
			continue
		end
		pending += 1
		task.spawn(function()
			local ok, result = pcall(function()
				local r = TextService:FilterStringAsync(tostring(text), player.UserId, Enum.TextFilterContext.PublicChat)
				return r:GetNonChatStringForUserAsync(player.UserId)
			end)
			if ok then
				if cached >= MAX_CACHED then
					table.clear(cache)
					cached = 0
				end
				cache[id] = result
				cached += 1
				out[key] = result
			else
				out[key] = UNSHOWN
			end
			pending -= 1
			if pending == 0 then
				done:Fire()
			end
		end)
	end
	if pending > 0 then
		done.Event:Wait()
	end
	done:Destroy()
	return out
end

return Filter
