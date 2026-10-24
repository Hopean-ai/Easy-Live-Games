-- Where the website is and how this game proves it is ours. The key itself is never in the repo:
-- it is a Roblox experience secret (Creator Dashboard > the experience > Secrets) holding the
-- same value as the website's ROBLOX_KEY. See roblox/README.md.
return {
	-- The website's address, without a trailing slash.
	baseUrl = "https://easy-live-games.milestpitts.workers.dev",
	-- The name of the Roblox secret that holds the key.
	secretName = "cfo_bridge_key",
}
