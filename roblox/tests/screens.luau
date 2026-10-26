-- Draws the Roblox screens outside Roblox, from what the website sends today, to catch a bad
-- property name or a view field the screens no longer understand. Lune's Roblox library checks
-- every property set; button presses and the server are faked. Run from roblox/:
--   node ../scripts/roblox-fixture.mjs > tests/fixture.json && lune run tests/screens
local fs = require("@lune/fs")
local serde = require("@lune/serde")
local Bridge = require("../src/shared/games/Cfo")
local Harness = require("./harness")

local fixture = serde.decode("json", fs.readFile("tests/fixture.json"))

local h = Harness.start({
	games = { "Cfo" },
	invoke = function(kind)
		if kind == "hello" then
			return { games = { { id = "cfo", name = "CFO", blurb = "An accounting board game.", players = "2–6", minPlayers = 2, maxPlayers = 6 } }, link = { linked = false } }
		elseif kind == "link" then
			return { link = { linked = true, admin = true, games = { { game = "bottles", code = "OTHR", updated = 2 }, { game = "cfo", code = "WXYZ", updated = 1 } } } }
		end
		return {}
	end,
})
local sent, has, press, pressNamed = h.sent, h.has, h.press, h.pressNamed
local function onState(msg: any)
	h.onState(msg)
end
assert(sent[1] and sent[1][1] == "hello", "the hub asks for the games and the account link")
assert(has("Play CFO"), "the picker lists the games")
assert(has("Have a link code?"), "an unlinked player can enter a link code")
press("Link", true)
assert(sent[#sent][1] == "link", "Link sends the code")
assert(has("Linked to your account (admin)") and has("Rejoin CFO game WXYZ"), "a linked player sees their games")
assert(not has("OTHR"), "but not rooms of games this build doesn't have")
press("Rejoin CFO game WXYZ")
assert(sent[#sent][1] == "join" and sent[#sent][2].game == "cfo" and sent[#sent][2].code == "WXYZ", "Rejoin joins that game's room")
press("All games")
press("Unlink account")
press("Tap again")
assert(sent[#sent][1] == "unlink", "unlinking asks twice, then tells the server")
press("Play CFO")
assert(has("New room") and has("All games"), "a game's lobby shows")
press("New room")
assert(sent[#sent][1] == "new" and sent[#sent][2] == "cfo", "New room asks the server for that game")
press("Quick match")
assert(sent[#sent][1] == "quick" and sent[#sent][2] == "cfo", "Quick match asks the server for that game")
assert(h.onState, "the client listens for state")
onState({ queue = { waiting = 2, max = 6, startsIn = 12 } })
assert(has("Finding players: 2 of 6"), "the queue shows")
press("Cancel")
assert(sent[#sent][1] == "cancel" and has("Quick match"), "cancelling goes back to the lobby")

onState({ game = "cfo", code = "ABCD", board = fixture.board })
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
for _, d in h.descendants() do
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
h.focused = {}
onState({ view = fixture.watching })
assert(has("Post entry"), "no redraw while typing")
h.focused = nil

press("Turn")
onState({ view = fixture.watching })
assert(not has("End turn"), "watchers get no moves")
print("screens ok: " .. #moves .. " moves drawn")
