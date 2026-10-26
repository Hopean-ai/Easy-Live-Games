-- Runs the hub's client outside Roblox for the screen tests (screens.luau, driftmail.luau). Real
-- instances from Lune's Roblox library sit behind thin wrappers that add the events Lune's
-- instances don't have, so every property the screens set is checked; button presses and the
-- server are faked. `invoke(kind, arg)` answers the client's requests to the server.
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local roblox = require("@lune/roblox")
local Hub = require("../src/shared/Hub")

local Harness = {}

function Harness.start(opts: { games: { string }, invoke: (string, any) -> any })
	local h: any = { sent = {}, focused = nil, onState = nil }
	local realOf: { [any]: any } = setmetatable({}, { __mode = "k" }) :: any
	local clicks: { [any]: () -> () } = {}
	local changed: { [any]: { [string]: () -> () } } = setmetatable({}, { __mode = "k" }) :: any
	local function unwrap(v: any): any
		return realOf[v] or v
	end
	local function wrap(inst: any): any
		if inst == nil then
			return nil
		end
		local proxy
		proxy = setmetatable({}, {
			__index = function(_, k)
				if k == "Activated" then
					return { Connect = function(_, fn) clicks[inst] = fn end }
				elseif k == "GetPropertyChangedSignal" then
					return function(_, prop)
						return { Connect = function(_, fn)
							changed[inst] = changed[inst] or {}
							changed[inst][prop] = fn
						end }
					end
				elseif k == "ClearAllChildren" then
					return function() inst:ClearAllChildren() end
				elseif k == "WaitForChild" then
					return function(_, name) return wrap(inst:FindFirstChild(name)) end
				end
				local v = inst[k]
				return if typeof(v) == "Instance" then wrap(v) else v
			end,
			__newindex = function(_, k, v)
				inst[k] = unwrap(v)
			end,
		})
		realOf[proxy] = inst
		return proxy
	end

	local playerGui = roblox.Instance.new("Folder")
	local services = {
		UserInputService = {
			GetFocusedTextBox = function() return h.focused end,
			TextBoxFocusReleased = { Connect = function() end },
		},
		Players = { LocalPlayer = { WaitForChild = function() return wrap(playerGui) end } },
		ReplicatedStorage = {
			WaitForChild = function(_, name)
				if name == "HubShared" then
					return {
						WaitForChild = function(_, child)
							if child == "games" then
								return { WaitForChild = function(_, m) return "shared:" .. m end }
							end
							return "shared:" .. child
						end,
					}
				end
				return {
					WaitForChild = function(_, remote)
						if remote == "Request" then
							return {
								InvokeServer = function(_, kind, arg)
									table.insert(h.sent, { kind, arg })
									return opts.invoke(kind, arg)
								end,
							}
						end
						return { OnClientEvent = { Connect = function(_, fn) h.onState = fn end } }
					end,
				}
			end,
		},
	}
	-- The client folder: the hub's Ui module and the games' screens.
	local modules = {}
	for _, name in opts.games do
		table.insert(modules, { Name = name, IsA = function(_, c) return c == "ModuleScript" end, path = "src/client/games/" .. name .. ".luau" })
	end
	local clientFolder = {
		WaitForChild = function(_, name)
			if name == "games" then
				return { GetChildren = function() return modules end }
			end
			return { path = "src/client/" .. name .. ".luau" }
		end,
	}
	local env = setmetatable({
		game = { GetService = function(_, name) return services[name] end },
		script = { Parent = clientFolder },
		require = nil :: any,
		Instance = { new = function(className) return wrap(roblox.Instance.new(className)) end },
		UDim2 = roblox.UDim2, UDim = roblox.UDim, Color3 = roblox.Color3, Vector2 = roblox.Vector2, Enum = roblox.Enum,
		-- Spawned work runs straight away, so the screens can be checked right after; waiting ends
		-- a polling loop, since nothing would change while it slept.
		task = { spawn = function(fn, ...) fn(...) end, delay = function() end, wait = function() error("stop", 0) end },
	}, { __index = _G })
	-- task.wait ends a loop by erroring; spawn swallows that one error.
	env.task.spawn = function(fn, ...)
		local ok, err = pcall(fn, ...)
		if not ok and err ~= "stop" then
			error(err, 0)
		end
	end
	local loaded = {}
	env.require = function(what)
		if what == "shared:Hub" then
			return Hub
		elseif type(what) == "string" and what:sub(1, 7) == "shared:" then
			return require("../src/shared/games/" .. what:sub(8))
		end
		assert(type(what) == "table" and what.path, "unexpected require")
		if not loaded[what.path] then
			loaded[what.path] = luau.load(fs.readFile(what.path), { debugName = what.path, environment = env })()
		end
		return loaded[what.path]
	end

	function h.texts(): { string }
		local out = {}
		for _, d in playerGui:GetDescendants() do
			if d:IsA("TextLabel") or d:IsA("TextButton") then
				table.insert(out, d.Text)
			end
		end
		return out
	end
	function h.has(fragment: string): boolean
		for _, t in h.texts() do
			if t:find(fragment, 1, true) then
				return true
			end
		end
		return false
	end
	function h.press(fragment: string, exact: boolean?)
		for _, d in playerGui:GetDescendants() do
			if d:IsA("TextButton") and (if exact then d.Text == fragment else d.Text:find(fragment, 1, true)) then
				clicks[d]()
				return
			end
		end
		error("no button with " .. fragment)
	end
	function h.pressNamed(name: string)
		for _, d in playerGui:GetDescendants() do
			if d.Name == name then
				clicks[d]()
				return
			end
		end
		error("nothing named " .. name)
	end
	function h.descendants()
		return playerGui:GetDescendants()
	end
	-- Types into the first text box whose placeholder has `fragment`.
	function h.type(fragment: string, value: string)
		for _, d in playerGui:GetDescendants() do
			if d:IsA("TextBox") and d.PlaceholderText:find(fragment, 1, true) then
				d.Text = value
				local fn = changed[d] and changed[d].Text
				if fn then
					fn()
				end
				return d
			end
		end
		error("no box for " .. fragment)
	end
	function h.last(): { any }
		return h.sent[#h.sent]
	end

	luau.load(fs.readFile("src/client/Main.client.luau"), { debugName = "Main.client", environment = env })()
	return h
end

return Harness
