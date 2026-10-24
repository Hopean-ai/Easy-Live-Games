-- Compiles every Luau file in src/, so a syntax error fails here rather than in Roblox. Run from
-- roblox/: lune run tests/syntax
local fs = require("@lune/fs")
local luau = require("@lune/luau")

local bad = 0
local function walk(dir: string)
	for _, name in fs.readDir(dir) do
		local path = dir .. "/" .. name
		if fs.isDir(path) then
			walk(path)
		elseif name:match("%.luau$") then
			local ok, err = pcall(luau.compile, fs.readFile(path))
			if not ok then
				bad += 1
				print("FAIL " .. path .. ": " .. tostring(err))
			end
		end
	end
end
walk("src")
if bad > 0 then
	error(bad .. " file(s) do not compile")
end
print("all files compile")
