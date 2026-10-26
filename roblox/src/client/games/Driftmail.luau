-- The Driftmail screens: your island, in tabs for the beach, writing a letter, fishing, your
-- journal and your letters. Driftmail is one shared ocean on the website, with no rooms, so the hub
-- opens these straight from the picker. Every request goes through the hub's server as "world",
-- which forwards it and filters whatever players wrote before it gets here. The island is the
-- player's linked account's, or one of their own.
return function(hub: any)
	local Ui, Bridge, state, ui, root = hub.Ui, hub.bridge, hub.state, hub.ui, hub.root
	local call, render, errorLine = hub.call, hub.render, hub.errorLine
	local make, corner, stroke, pad, label, heading, small = Ui.make, Ui.corner, Ui.stroke, Ui.pad, Ui.label, Ui.heading, Ui.small
	local button, chip, column, row, card, pair, textBox = Ui.button, Ui.chip, Ui.column, Ui.row, Ui.card, Ui.pair, Ui.textBox
	local BG, PANEL, ACCENT, WARN, MUTED = Ui.BG, Ui.PANEL, Ui.ACCENT, Ui.WARN, Ui.MUTED
	local PAPER = Color3.fromHex("#f3ead6")
	local OLD_PAPER = Color3.fromHex("#e9dcc0")
	local SEA = Color3.fromHex("#1d4e6b")

	local TABS = { { id = "beach", name = "Beach" }, { id = "write", name = "Write" }, { id = "fish", name = "Fishing" }, { id = "journal", name = "Journal" }, { id = "letters", name = "Letters" } }

	local function reset()
		ui.view = nil
		ui.tab = "beach"
		ui.reading = nil -- a letter on the shelf, or a journal page
		ui.note = nil -- what just happened: what the tide left, what bit, where the bottle went
		ui.letter = ""
		ui.dir = nil
		ui.strength = 2
		ui.signed = false
		ui.glue = false
		ui.page = 0 -- index into the journal, 0 for none
		ui.replyTo = nil
		ui.polling = nil
	end

	local function text(view: any, key: string?): string?
		return key and view.texts and view.texts[key] or nil
	end

	-- Sends one request to the ocean and keeps the view it answers with.
	local function ask(op: string, fields: { [string]: any }?): any
		local arg = { game = Bridge.ID, op = op }
		for k, v in fields or {} do
			arg[k] = v
		end
		local res = call("world", arg)
		if res and res.view then
			ui.view = res.view
			render()
		end
		return res and res.view
	end

	-- While the screens are open, the island is asked for again every half minute.
	local function startPolling()
		if ui.polling then
			return
		end
		local token = {}
		ui.polling = token
		task.spawn(function()
			local first = true
			while ui.polling == token and state.game == Bridge.ID do
				local v = ask("state")
				if first and v and v.found and #v.found > 0 then
					ui.note = "The tide left you " .. Bridge.list(v.found) .. "."
					render()
				end
				first = false
				task.wait(Bridge.POLL_SECONDS)
			end
		end)
	end

	local function clockLine(v: any): string
		return Bridge.cap(v.clock.part) .. " on your island, " .. v.clock.words .. "."
	end

	---------------------------------------------------------------------------------------------------
	-- Reading

	local function readLetter(l: any)
		ui.reading = l
		render()
	end

	local function renderReader(col: Frame, v: any, l: any)
		local note
		if l.journalPage then
			note = if l.teaches then "A page from your journal. It taught you " .. l.teaches .. "." else "A page from your journal."
		elseif l.old then
			note = "An old bottle, crusted with barnacles, washed up on your " .. l.shore .. " beach. Inside is a page torn from someone's journal."
		elseif l.own then
			note = "Your own bottle washed back to your " .. l.shore .. " beach. Nobody else was in reach."
		else
			note = "Washed up on your " .. l.shore .. " beach at " .. l.part .. ", " .. l.tide .. "."
		end
		if l.handOf then
			note ..= if l.handOf.letters > 1
				then " You know this hand: it's hand " .. l.handOf.mark .. ", on " .. l.handOf.letters .. " letters on your shelf."
				else " A hand you haven't seen before (hand " .. l.handOf.mark .. ")."
		end
		small(note, { TextSize = 13, Parent = col, LayoutOrder = 1 })
		local font, ink = Bridge.hand(l.hand)
		local paper = make("Frame", { BackgroundColor3 = if l.old or l.journalPage then OLD_PAPER else PAPER, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0), Parent = col, LayoutOrder = 2 }, { corner(4), pad(16) })
		local inner = column({ Parent = paper }, 8)
		local reply = text(v, l.replyTo)
		if reply then
			small("In answer to your letter: “" .. reply .. "”", { TextColor3 = Color3.fromHex("#6b604f"), Parent = inner, LayoutOrder = 1 })
		end
		if l.title then
			small(l.title, { TextColor3 = Color3.fromHex("#6b604f"), Parent = inner, LayoutOrder = 2 })
		end
		label(text(v, l.text) or l.body or "", { Font = (Enum.Font :: any)[font], TextSize = 22, TextColor3 = Color3.fromHex(ink), Parent = inner, LayoutOrder = 3 })
		local name = text(v, l.name)
		if name then
			label("— " .. name, { Font = (Enum.Font :: any)[font], TextSize = 20, TextColor3 = Color3.fromHex(ink), TextXAlignment = Enum.TextXAlignment.Right, Parent = inner, LayoutOrder = 4 })
		end
		if not l.journalPage then
			local glyph, wax = Bridge.seal(l.emblem)
			label(glyph .. (if l.marked then " ≈≈" else ""), { TextColor3 = Color3.fromHex(wax), TextSize = 20, TextXAlignment = Enum.TextXAlignment.Right, Parent = inner, LayoutOrder = 5 })
			if l.marked then
				small("A faint wave is pressed into the wax: this island is kept by Claude.", { TextColor3 = Color3.fromHex("#6b604f"), Parent = inner, LayoutOrder = 6 })
			end
		end
		if l.page then
			local pg = make("Frame", { BackgroundColor3 = OLD_PAPER, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0), Parent = col, LayoutOrder = 3 }, { corner(4), pad(16) })
			local pc = column({ Parent = pg }, 6)
			small("A copied journal page is folded in with it: “" .. l.page.title .. "”", { TextColor3 = Color3.fromHex("#6b604f"), Parent = pc, LayoutOrder = 1 })
			label(l.page.text, { Font = (Enum.Font :: any)[font], TextSize = 18, TextColor3 = Color3.fromHex(ink), Parent = pc, LayoutOrder = 2 })
		end
		if l.learned then
			label("You learned something: " .. l.learned .. ".", { TextColor3 = ACCENT, Parent = col, LayoutOrder = 4 })
		end
		if not l.own and not l.old and not l.journalPage then
			button("Write back", function()
				ui.replyTo = l
				ui.reading = nil
				ui.tab = "write"
				render()
			end, { Parent = col, LayoutOrder = 5 })
		end
		button(if l.journalPage then "Close the journal" else "Put it on the shelf", function()
			ui.reading = nil
			render()
		end, { Parent = col, LayoutOrder = 6 }, "secondary")
	end

	---------------------------------------------------------------------------------------------------
	-- The tabs

	local function renderBeach(col: Frame, v: any)
		local sea = make("Frame", { BackgroundColor3 = SEA, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0), Parent = col, LayoutOrder = 1 }, { corner(10), pad(12) })
		local sc = column({ Parent = sea }, 6)
		if #v.beach == 0 then
			small("Nothing on the sand right now. Watch the wet sand as the tide goes out.", { TextColor3 = Color3.fromHex("#d9eef7"), Parent = sc, LayoutOrder = 1 })
		end
		for i, b in v.beach do
			button((if b.old then "An old, barnacled bottle" else "A bottle") .. " on your " .. b.shore .. " beach. Open it", function()
				local res = ask("open", { id = b.id })
				if res and res.opened then
					for _, l in res.shelf do
						if l.id == res.opened then
							l.learned = res.learned
							readLetter(l)
							break
						end
					end
				end
			end, { Parent = sc, LayoutOrder = i }, "secondary")
		end
		local _, sup = card({ Parent = col, LayoutOrder = 2 })
		heading("Supplies", { Parent = sup, LayoutOrder = 1 })
		pair(sup, "Bottles", tostring(v.supplies.bottles), 2)
		pair(sup, "Corks", tostring(v.supplies.corks), 3)
		pair(sup, "Paper", tostring(v.supplies.paper), 4)
		pair(sup, "Ink", tostring(v.supplies.ink), 5)
		small("A letter takes a bottle, a cork, a sheet of paper and some ink. Every bottle you open leaves you its glass and cork, and each tide may wash something new up.", { Parent = sup, LayoutOrder = 6 })
		local _, cur = card({ Parent = col, LayoutOrder = 3 })
		heading("Washed up beside you", { Parent = cur, LayoutOrder = 1 })
		for i, c in v.curios do
			label(Bridge.cap(c.name) .. (if c.unique then "  (one of a kind)" else ""), { TextColor3 = if c.unique then WARN else Ui.FG, Parent = cur, LayoutOrder = 1 + i })
		end
	end

	local function renderWrite(col: Frame, v: any)
		if ui.replyTo then
			small("Answering the letter from your " .. ui.replyTo.shore .. " beach. Throw back the way it came and it may find its way home.", { Parent = col, LayoutOrder = 1 })
		end
		local font, ink = Bridge.hand(v.hand)
		local box = textBox({
			PlaceholderText = "Write to whoever finds this…", Text = ui.letter, MultiLine = true, TextWrapped = true,
			TextYAlignment = Enum.TextYAlignment.Top, Font = (Enum.Font :: any)[font], TextSize = 20, TextColor3 = Color3.fromHex(ink),
			BackgroundColor3 = PAPER, PlaceholderColor3 = Color3.fromHex("#8a7d66"), Size = UDim2.new(1, 0, 0, 160), Parent = col, LayoutOrder = 2,
		})
		box:GetPropertyChangedSignal("Text"):Connect(function()
			ui.letter = box.Text
		end)
		small("Up to " .. Bridge.MAX_LETTER .. " characters.", { Parent = col, LayoutOrder = 3 })
		local opts = row({ Parent = col, LayoutOrder = 4 })
		chip((if ui.signed then "✓ " else "") .. "Sign it with my name", function()
			ui.signed = not ui.signed
			render()
		end, { Parent = opts, LayoutOrder = 1 })
		if v.kit.glue > 0 then
			chip((if ui.glue then "✓ " else "") .. "Seal with fish glue", function()
				ui.glue = not ui.glue
				render()
			end, { Parent = opts, LayoutOrder = 2 })
		end
		if #v.journal > 0 then
			local p = v.journal[ui.page]
			chip("Fold in a page: " .. (if p then p.title else "none"), function()
				ui.page = (ui.page + 1) % (#v.journal + 1)
				render()
			end, { Parent = opts, LayoutOrder = 3 })
		end
		heading("Which way do you throw it?", { TextSize = 14, Parent = col, LayoutOrder = 5 })
		local dirs = row({ Parent = col, LayoutOrder = 6 })
		for i, d in Bridge.DIRS do
			chip(d, function()
				ui.dir = i - 1
				render()
			end, { Parent = dirs, LayoutOrder = i }, if ui.dir == i - 1 then "primary" else "secondary")
		end
		local hard = row({ Parent = col, LayoutOrder = 7 })
		for i, s in Bridge.STRENGTHS do
			chip(s.name, function()
				ui.strength = i
				render()
			end, { Parent = hard, LayoutOrder = i }, if ui.strength == i then "primary" else "secondary")
		end
		small("Right now it's " .. v.clock.part .. ", " .. v.clock.words .. "." .. (if v.clock.ebbing then " An outgoing tide carries bottles far." else ""), { Parent = col, LayoutOrder = 8 })
		button("Throw it to sea", function()
			if ui.dir == nil then
				state.error = "Pick which way to throw it."
				render()
				return
			end
			local p = v.journal[ui.page]
			local dir = ui.dir
			local res = ask("throw", {
				text = ui.letter, dir = dir, strength = Bridge.STRENGTHS[ui.strength].value, signed = ui.signed,
				glue = ui.glue, page = p and p.id, replyTo = ui.replyTo and ui.replyTo.id,
			})
			if res then
				ui.letter, ui.dir, ui.replyTo, ui.glue, ui.page = "", nil, nil, false, 0
				ui.note = "Your bottle bobs away to the " .. Bridge.DIR_WORDS[dir + 1] .. "."
				ui.tab = "beach"
				render()
			end
		end, { Parent = col, LayoutOrder = 9 })
		if ui.replyTo then
			button("Not a reply after all", function()
				ui.replyTo = nil
				render()
			end, { Parent = col, LayoutOrder = 10 }, "link")
		end
	end

	local function renderFishing(col: Frame, v: any)
		local kit = v.kit
		local _, c = card({ Parent = col, LayoutOrder = 1 })
		heading("Your catch", { Parent = c, LayoutOrder = 1 })
		pair(c, "Fish", tostring(kit.fish), 2)
		pair(c, "Bones", tostring(kit.bones), 3)
		pair(c, "Fish glue", tostring(kit.glue), 4)
		pair(c, "Hook", if kit.hook then "bone" else "nail", 5)
		button(if kit.casts < 1 then "Fished out this tide" else "Cast a line", function()
			if kit.casts < 1 then
				return
			end
			local res = ask("fish")
			if res and res.caught then
				ui.note = if res.caught == "nothing" then "Nothing bit. The line comes back empty." else "You caught " .. res.caught .. "."
				render()
			end
		end, { Parent = col, LayoutOrder = 2 }, if kit.casts < 1 then "secondary" else "primary")
		if not kit.hook then
			button("Make a bone hook (" .. kit.hookCost .. " bones)", function()
				if ask("craft", { what = "hook" }) then
					ui.note = "You carve and bind a bone hook. It bites better than the old nail."
					render()
				end
			end, { Parent = col, LayoutOrder = 3 }, "secondary")
		end
		button("Boil down glue (" .. kit.glueCost .. " fish)", function()
			if ask("craft", { what = "glue" }) then
				ui.note = "You boil the fish down into a pot of sticky glue."
				render()
			end
		end, { Parent = col, LayoutOrder = 4 }, "secondary")
		small("You can fish once a tide. Dawn, dusk and a rising tide are best. Fish bones make a hook, and fish boil down into a glue that seals a bottle in place of a cork.", { Parent = col, LayoutOrder = 5 })
	end

	local function renderJournal(col: Frame, v: any)
		for i, a in v.abilities do
			label(a.name, { TextColor3 = ACCENT, Parent = col, LayoutOrder = i * 2 - 1 })
			small(a.words, { Parent = col, LayoutOrder = i * 2 })
		end
		if v.forecast then
			heading("What the sea will do", { TextSize = 14, Parent = col, LayoutOrder = 20 })
			if #v.forecast == 0 then
				small("The sea will stay calm for the next two island days.", { Parent = col, LayoutOrder = 21 })
			end
			for i, f in v.forecast do
				label(Bridge.cap(f.name) .. " " .. Bridge.untilText(v.now, f.start) .. ".", { TextColor3 = WARN, Parent = col, LayoutOrder = 21 + i })
			end
		end
		heading("Pages", { TextSize = 14, Parent = col, LayoutOrder = 40 })
		if #v.journal == 0 then
			small("Old bottles sometimes hold pages from journals kept here long ago. Some teach you things.", { Parent = col, LayoutOrder = 41 })
		end
		for i, p in v.journal do
			button(p.title .. (if p.teaches then "  (teaches " .. p.teaches .. ")" else ""), function()
				readLetter({ journalPage = true, old = true, title = p.title, body = p.text, teaches = p.teaches, hand = 0 })
			end, { Parent = col, LayoutOrder = 41 + i }, "secondary")
		end
	end

	local function renderLetters(col: Frame, v: any)
		heading("Letters you've found", { TextSize = 14, Parent = col, LayoutOrder = 1 })
		if #v.shelf == 0 then
			small("Nothing yet. Watch the wet sand as the tide goes out.", { Parent = col, LayoutOrder = 2 })
		elseif v.shelfCount > #v.shelf then
			small("The newest " .. #v.shelf .. " of " .. v.shelfCount .. ".", { Parent = col, LayoutOrder = 2 })
		end
		for i, l in v.shelf do
			local body = text(v, l.text) or l.body or ""
			local what = if l.old then "An old journal page: " .. (l.title or Bridge.firstLine(body))
				elseif l.own then "Your own letter, back again: " .. Bridge.firstLine(body)
				else Bridge.firstLine(body)
			button(what .. "\n" .. l.shore .. " beach, " .. Bridge.ago(v.now, l.landed), function()
				readLetter(l)
			end, { Parent = col, LayoutOrder = 2 + i, TextXAlignment = Enum.TextXAlignment.Left }, "secondary")
		end
		heading("Bottles you've thrown", { TextSize = 14, Parent = col, LayoutOrder = 100 })
		if #v.sent == 0 then
			small("None yet.", { Parent = col, LayoutOrder = 101 })
		end
		for i, s in v.sent do
			local where = if s.ashore then (if s.rest then "Washed up somewhere, it " .. s.rest else "Washed up somewhere") else "Still drifting"
			label(Bridge.firstLine(text(v, s.text)), { Parent = col, LayoutOrder = 100 + i * 2 })
			small(where .. " · thrown " .. Bridge.ago(v.now, s.thrown) .. (if s.page then " · with “" .. s.page .. "”" else ""), { Parent = col, LayoutOrder = 101 + i * 2 })
		end
	end

	---------------------------------------------------------------------------------------------------

	local function renderScreen(_view: any)
		startPolling()
		local scroll = make("ScrollingFrame", {
			Size = UDim2.fromScale(1, 1), BackgroundTransparency = 1, BorderSizePixel = 0, ScrollBarThickness = 6,
			CanvasSize = UDim2.new(0, 0, 0, 0), AutomaticCanvasSize = Enum.AutomaticSize.Y, Parent = root,
		})
		local outer = make("Frame", { AnchorPoint = Vector2.new(0.5, 0), Position = UDim2.new(0.5, 0, 0, 16), Size = UDim2.new(1, -32, 0, 0), AutomaticSize = Enum.AutomaticSize.Y, BackgroundTransparency = 1, Parent = scroll }, {
			make("UISizeConstraint", { MaxSize = Vector2.new(620, math.huge) }),
		})
		local col = column({ Parent = outer }, 10)
		local top = row({ Parent = col, LayoutOrder = 1 })
		chip("All games", function()
			ui.polling = nil
			state.game = nil
			render()
		end, { Parent = top, LayoutOrder = 1 }, "link")
		label("Driftmail", { Font = Enum.Font.GothamBold, TextSize = 28, TextColor3 = ACCENT, Parent = col, LayoutOrder = 2 })
		local v = ui.view
		if not v then
			small(if state.error then "Your island could not be reached." else "Wading ashore…", { Parent = col, LayoutOrder = 3 })
			if state.error then
				button("Try again", function()
					ask("state")
				end, { Parent = col, LayoutOrder = 4 }, "secondary")
			end
			errorLine(col, 5)
			return
		end
		small(clockLine(v), { TextSize = 14, Parent = col, LayoutOrder = 3 })
		if v.event then
			label(v.event.words, { TextColor3 = WARN, Parent = col, LayoutOrder = 4 })
		elseif v.sign then
			label(v.sign, { TextColor3 = Color3.fromHex("#cfe3ee"), Font = Enum.Font.GothamMedium, Parent = col, LayoutOrder = 4 })
		end
		if ui.note then
			local f = make("Frame", { BackgroundColor3 = Color3.fromHex("#20303a"), AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0), Parent = col, LayoutOrder = 5 }, { corner(8), pad(8) })
			label(ui.note, { TextColor3 = Color3.fromHex("#d9eef7"), Parent = f })
		end
		errorLine(col, 6)
		local body = column({ Parent = col, LayoutOrder = 10 }, 8)
		if ui.reading then
			renderReader(body, v, ui.reading)
			return
		end
		local tabs = row({ Parent = col, LayoutOrder = 7 })
		for i, t in TABS do
			chip(t.name .. (if t.id == "beach" and #v.beach > 0 then " (" .. #v.beach .. ")" else ""), function()
				ui.tab = t.id
				state.error = nil
				render()
			end, { Parent = tabs, LayoutOrder = i }, if ui.tab == t.id then "primary" else "secondary")
		end
		if ui.tab == "write" then
			renderWrite(body, v)
		elseif ui.tab == "fish" then
			renderFishing(body, v)
		elseif ui.tab == "journal" then
			renderJournal(body, v)
		elseif ui.tab == "letters" then
			renderLetters(body, v)
		else
			renderBeach(body, v)
		end
	end

	return { render = renderScreen, reset = reset, world = true }
end
