-- Draws the Roblox screens outside Roblox, from what the website sends today, to catch a bad
-- property name or a view field the screens no longer understand. Lune's Roblox library checks
-- every property set; button presses and the server are faked. Run from roblox/:
--   node ../scripts/roblox-fixture.mjs > tests/fixture.json && lune run tests/screens
local fs = require("@lune/fs")
local luau = require("@lune/luau")
local serde = require("@lune/serde")
local roblox = require("@lune/roblox")
local Bridge = require("../src/shared/Bridge")

local fixture = serde.decode("json", fs.readFile("tests/fixture.json"))

-- Real instances behind thin wrappers that add the events Lune's instances don't have.
local realOf: { [any]: any } = setmetatable({}, { __mode = "k" }) :: any
local clicks: { [any]: () -> () } = {}
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
				return function() return { Connect = function() end } end
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
local sent: { { any } } = {}
local onState: ((any) -> ())? = nil
local focused: any = nil
local services = {
	UserInputService = {
		GetFocusedTextBox = function() return focused end,
		TextBoxFocusReleased = { Connect = function() end },
	},
	Players = { LocalPlayer = { WaitForChild = function() return wrap(playerGui) end } },
	ReplicatedStorage = {
		WaitForChild = function(_, name)
			if name == "CfoShared" then
				return { WaitForChild = function() return "Bridge" end }
			end
			return {
				WaitForChild = function(_, remote)
					if remote == "Request" then
						return {
							InvokeServer = function(_, kind, arg)
								table.insert(sent, { kind, arg })
								if kind == "link" then
									return { link = { linked = true, admin = true, games = { { code = "WXYZ", updated = 0 } } } }
								end
								return {}
							end,
						}
					end
					return { OnClientEvent = { Connect = function(_, fn) onState = fn end } }
				end,
			}
		end,
	},
}
local env = setmetatable({
	game = { GetService = function(_, name) return services[name] end },
	require = function(what) assert(what == "Bridge"); return Bridge end,
	Instance = { new = function(className) return wrap(roblox.Instance.new(className)) end },
	UDim2 = roblox.UDim2, UDim = roblox.UDim, Color3 = roblox.Color3, Vector2 = roblox.Vector2, Enum = roblox.Enum,
	-- Spawned work runs straight away, so the screens can be checked right after.
	task = { spawn = function(fn, ...) fn(...) end, delay = function() end, wait = function() end },
}, { __index = _G })

local function texts(): { string }
	local out = {}
	for _, d in playerGui:GetDescendants() do
		if d:IsA("TextLabel") or d:IsA("TextButton") then
			table.insert(out, d.Text)
		end
	end
	return out
end
local function has(fragment: string): boolean
	for _, t in texts() do
		if t:find(fragment, 1, true) then
			return true
		end
	end
	return false
end
local function press(fragment: string, exact: boolean?)
	for _, d in playerGui:GetDescendants() do
		if d:IsA("TextButton") and (if exact then d.Text == fragment else d.Text:find(fragment, 1, true)) then
			clicks[d]()
			return
		end
	end
	error("no button with " .. fragment)
end
local function pressNamed(name: string)
	for _, d in playerGui:GetDescendants() do
		if d.Name == name then
			clicks[d]()
			return
		end
	end
	error("nothing named " .. name)
end

luau.load(fs.readFile("src/client/Main.client.luau"), { debugName = "Main.client", environment = env })()
assert(has("New room"), "the lobby shows")
assert(sent[1] and sent[1][1] == "account", "the lobby asks whether this player is linked")
assert(has("Have a link code?"), "an unlinked player can enter a link code")
press("Link", true)
assert(sent[#sent][1] == "link", "Link sends the code")
assert(has("Linked to your account (admin)") and has("Rejoin game WXYZ"), "a linked player sees their games")
press("Rejoin game WXYZ")
assert(sent[#sent][1] == "join" and sent[#sent][2] == "WXYZ", "Rejoin joins that room")
press("Unlink account")
press("Tap again")
assert(sent[#sent][1] == "unlink", "unlinking asks twice, then tells the server")
press("New room")
assert(sent[#sent][1] == "new", "New room asks the server")
press("Quick match")
assert(sent[#sent][1] == "quick", "Quick match asks the server")
assert(onState, "the client listens for state")
onState({ queue = { waiting = 2, max = 6, startsIn = 12 } })
assert(has("Finding players: 2 of 6"), "the queue shows")
press("Cancel")
assert(sent[#sent][1] == "cancel" and has("Quick match"), "cancelling goes back to the lobby")

onState({ code = "ABCD", board = fixture.board })
onState({ view = fixture.waiting })
assert(has("Room ABCD"), "the waiting room shows its code")
assert(has("Waiting for the host"), "a guest waits for the host")

onState({ view = fixture.playing })
local game = fixture.playing.game
local moves = game.moves
assert(#moves > 0, "the fixture has moves")
for _, m in moves do
	assert(has(m.label), "the move " .. m.label .. " has a button")
end
assert(has("Your turn"), "the turn line shows")
assert(not has("Miles"), "web names stay masked")
local plain
for _, m in moves do
	if not m.input and not m.confirm then
		plain = m
		break
	end
end
if plain then
	press(plain.label)
	local last = sent[#sent]
	assert(last[1] == "send" and last[2].t == "act" and last[2].a == plain.action.a, "a move button sends its action")
end
local squares = 0
for _, d in playerGui:GetDescendants() do
	if d:IsA("Frame") and d.Size.X.Scale > 0 and d.Size.X.Scale < 0.1 then
		squares += 1
	end
end
assert(squares >= #fixture.board.squares, "the board is drawn")

-- Picking an owned square shows it, with a deal offer that knows the square.
local owned
for pos, t in game.tiles do
	if t and t.owner ~= nil then
		owned = pos - 1
		break
	end
end
assert(owned, "the fixture has an owned square")
pressNamed("Square" .. owned)
local sq = fixture.board.squares[owned + 1]
assert(has("Owned by"), "the square picked is described")
press("Offer to")
assert(has(fixture.board.forms.offer.title), "the deal form opens")
press(fixture.board.forms.offer.submit)
local offer = sent[#sent][2]
assert(offer.a == "offer" and offer.pos == owned, "the offer names the square")

-- The board plan, from its form description.
press(fixture.board.forms.plan.title)
press(fixture.board.forms.plan.fields[1].options[1].name, true)
press(fixture.board.forms.plan.submit)
local plan = sent[#sent][2]
assert(plan.a == "plan" and plan.pricing == fixture.board.forms.plan.fields[1].options[1].id, "the plan form sends its choice")

-- The books: documents, the journal, and an entry edited and saved.
press("Books")
local books = game.books
assert(has("Documents (" .. #books.docs .. " in the inbox"), "the inbox shows")
assert(has(books.docs[#books.docs].text), "the newest document shows")
local entry = books.entries[1]
assert(has(entry.memo), "the journal shows the posted entry")
press("Edit", true)
assert(has("Change this entry"), "the editor opens")
press("Save entry")
local saved = sent[#sent][2]
assert(saved.a == "entry" and saved.entry == entry.id and #saved.lines == #entry.lines, "saving sends the entry's lines")
for i, l in entry.lines do
	assert(saved.lines[i][1] == l[1] and saved.lines[i][2] == l[2], "line " .. i .. " is unchanged")
end
assert(Bridge.cleanMessage(saved), "the server forwards the entry")

-- A new entry: the account picker fills the line; an entry with no amounts isn't sent.
local before = #sent
press("Write entry")
assert(has("New journal entry") and has("For: "), "writing an entry for a document opens the editor")
press("Account…")
assert(has("Pick an account"), "the account picker opens")
press(fixture.board.accounts[1].name, true)
assert(not has("Pick an account"), "picking an account closes the picker")
press("Post entry")
assert(#sent == before, "an entry with no amounts is not sent")
assert(has("Every line needs a debit or a credit."), "and says why")

-- Typing waits for redraws: nothing is redrawn while a box has the cursor.
focused = {}
onState({ view = fixture.watching })
assert(has("Post entry"), "no redraw while typing")
focused = nil

press("Turn")
onState({ view = fixture.watching })
assert(not has("End turn"), "watchers get no moves")
print("screens ok: " .. #moves .. " moves drawn")
