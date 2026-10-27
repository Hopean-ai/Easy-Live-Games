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

	local TABS = {
		{ id = "beach", name = "Beach" }, { id = "write", name = "Write" }, { id = "island", name = "Island" }, { id = "build", name = "Build" },
		{ id = "fish", name = "Fishing" }, { id = "journal", name = "Journal" }, { id = "letters", name = "Letters" },
	}
	local VESSELS = { jar = "A sealed jar", box = "A wooden box", barrel = "A barrel", double = "A double-corked bottle", weighted = "A weighted bottle", sailed = "A little sailed float" }
	local STRANGE = {
		knowing = "A bottle with no seal washed up, very cold to the touch. Nobody signed it. It seems to know you.",
		future = "A bottle with no seal washed up. The letter inside is dated days from now.",
		clue = "A bottle with no seal washed up. Inside are only numbers, and a shape like the tide.",
		echo = "A bottle with no seal washed up. The letter is in your own hand, but you never wrote it quite like this.",
		fog = "Your own bottle came back out of the fog. The words are yours, mostly.",
	}

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
		ui.kind = 1 -- index into the containers the player can use
		ui.curio = 0 -- index into the curios, 0 for none
		ui.seeds = 0 -- index into the seeds the player has, 0 for none
		ui.map = false
		ui.wax = false
		ui.stamp = true
		ui.shimmer = false
		ui.forge = 0 -- index into the hands the player can copy, 0 for their own
		ui.bait = false
		ui.fishing = nil
		ui.passing = false
		ui.passDir = 0
		ui.passLine = ""
		ui.glyph = nil
		ui.waxColour = nil
		ui.pattern = 0
		ui.polling = nil
	end

	local usable, seedList, forgeable
	local answer, strike, castAt

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
					ui.note = (if v.welcome then "Welcome back. While you were away the sea saved a few things for you. " else "")
						.. "The tide left you " .. Bridge.list(v.found) .. "."
					render()
				end
				first = false
				task.wait(Bridge.POLL_SECONDS)
			end
		end)
	end

	-- Runs an action and, if it worked, says what happened.
	local function doing(op: string, fields: { [string]: any }?, words: string | (any) -> string)
		local res = ask(op, fields)
		if res then
			ui.note = if type(words) == "function" then words(res) else words
			render()
		end
		return res
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
		elseif l.strange then
			note = STRANGE[l.strange] or STRANGE.knowing
		elseif l.old then
			note = "An old bottle, crusted with barnacles, washed up on your " .. l.shore .. " beach. Inside is a page torn from someone's journal."
		elseif l.own then
			note = "Your own bottle washed back to your " .. l.shore .. " beach. Nobody else was in reach."
		else
			local vessel = VESSELS[l.kind]
			note = (if vessel then vessel .. " washed" else "Washed") .. " up on your " .. l.shore .. " beach at " .. l.part .. ", " .. l.tide .. "."
		end
		if l.broken then
			note ..= " It had broken open in a storm: only the letter survived."
		end
		if l.blurred == "blurred" then
			note ..= " Water got in, and some of the words have run."
		elseif l.blurred == "restored" then
			note ..= " Water got in, but you can read the lost words in the dents of the pen."
		end
		if l.stained then
			note ..= " The paper is stained red from the tide."
		end
		if l.shimmer then
			note ..= " The ink shimmers when you tilt it."
		end
		if l.forged then
			note ..= " Something about the hand is off, as if someone were copying it."
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
		local added = l.added and text(v, l.added.text)
		if added then
			local afont, aink = Bridge.hand(l.added.hand)
			label(added, { Font = (Enum.Font :: any)[afont], TextSize = 20, TextColor3 = Color3.fromHex(aink), Parent = inner, LayoutOrder = 5 })
		end
		if not l.journalPage and not l.strange then
			local glyph, wax = Bridge.seal(l.emblem)
			local waxed = l.old or l.sealed
			label(glyph .. (if l.marked then " ≈≈" else "") .. (if waxed then "" else "  (pressed in the cork)"), {
				TextColor3 = if waxed then Color3.fromHex(wax) else Color3.fromHex("#6b604f"), TextSize = 20,
				TextXAlignment = Enum.TextXAlignment.Right, Parent = inner, LayoutOrder = 6,
			})
			if l.stamp then
				small("Stamped: " .. l.stamp, { TextColor3 = Color3.fromHex("#284678"), Parent = inner, LayoutOrder = 7 })
			end
			if l.marked then
				small("A faint wave is pressed into the wax: this island is kept by Claude.", { TextColor3 = Color3.fromHex("#6b604f"), Parent = inner, LayoutOrder = 8 })
			end
		end
		if l.page then
			local pg = make("Frame", { BackgroundColor3 = OLD_PAPER, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0), Parent = col, LayoutOrder = 3 }, { corner(4), pad(16) })
			local pc = column({ Parent = pg }, 6)
			small("A copied journal page is folded in with it: “" .. l.page.title .. "”", { TextColor3 = Color3.fromHex("#6b604f"), Parent = pc, LayoutOrder = 1 })
			label(l.page.text, { Font = (Enum.Font :: any)[font], TextSize = 18, TextColor3 = Color3.fromHex(ink), Parent = pc, LayoutOrder = 2 })
		end
		for i, it in l.items or {} do
			local words
			if it.kind == "curio" then
				words = "Tucked in with it: " .. it.name .. "."
			elseif it.kind == "seeds" then
				words = "A pinch of seeds, wrapped in a leaf: " .. (v.crops[it.crop] and v.crops[it.crop].seed or it.crop) .. "."
			elseif it.kind == "materials" then
				words = "Packed in with it: " .. Bridge.costWords(it.what) .. "."
			elseif it.kind == "drawing" then
				words = "A drawing is folded in with it. Drawings can only be seen on the website."
			elseif it.kind == "map" then
				local places = {}
				for _, p in it.places or {} do
					table.insert(places, (text(v, p.name) or "someone") .. ", off their " .. p.shore .. " beach")
				end
				words = if #places > 0 then "A hand-drawn chart of who writes to them: " .. table.concat(places, "; ") .. "." else "A hand-drawn chart of an island, and empty sea all round it."
			end
			if words then
				small(words, { Parent = col, LayoutOrder = 3, Name = "Item" .. i })
			end
		end
		if l.learned then
			label("You learned something: " .. l.learned .. ".", { TextColor3 = ACCENT, Parent = col, LayoutOrder = 4 })
		end
		if l.player then
			local marks = row({ Parent = col, LayoutOrder = 4 })
			for i, m in Bridge.MARKS do
				chip((if l.mark == m then "✓ " else "") .. "Mark it " .. m, function()
					if l.mark then
						return
					end
					if doing("mark", { id = l.id, mark = m }, "The sea will remember.") then
						l.mark = m
						render()
					end
				end, { Parent = marks, LayoutOrder = i }, if l.mark == m then "primary" else "secondary")
			end
		end
		if l.id and not l.old and not l.journalPage then
			if ui.passing then
				local box = textBox({ PlaceholderText = "Add a line of your own (optional)", Text = ui.passLine, Size = UDim2.new(1, 0, 0, 36), Parent = col, LayoutOrder = 7 })
				box:GetPropertyChangedSignal("Text"):Connect(function()
					ui.passLine = box.Text
				end)
				local dirs = row({ Parent = col, LayoutOrder = 8 })
				for i, d in Bridge.DIRS do
					chip(d, function()
						ui.passDir = i - 1
						render()
					end, { Parent = dirs, LayoutOrder = i }, if ui.passDir == i - 1 then "primary" else "secondary")
				end
				button("Throw it on", function()
					local dir = ui.passDir
					if doing("pass", { id = l.id, line = ui.passLine, dir = dir }, "You throw it on to the " .. Bridge.DIR_WORDS[dir + 1] .. ".") then
						ui.passing, ui.passLine, ui.reading = false, "", nil
						render()
					end
				end, { Parent = col, LayoutOrder = 9 })
			else
				button("Throw it on…", function()
					ui.passing = true
					render()
				end, { Parent = col, LayoutOrder = 9 }, "secondary")
			end
		end
		if l.id and not l.journalPage then
			button("Burn it", function()
				if doing("burn", { id = l.id }, "The letter curls up in the fire and is gone.") then
					ui.reading, ui.passing = nil, false
					render()
				end
			end, { Parent = col, LayoutOrder = 10 }, "secondary")
		end
		if l.player then
			button("Write back", function()
				ui.replyTo = l
				ui.reading = nil
				ui.tab = "write"
				render()
			end, { Parent = col, LayoutOrder = 5 })
		end
		button(if l.journalPage then "Close the journal" else "Put it on the shelf", function()
			ui.reading, ui.passing = nil, false
			render()
		end, { Parent = col, LayoutOrder = 11 }, "secondary")
	end

	---------------------------------------------------------------------------------------------------
	-- The tabs

	-- The containers the player can send a letter in right now.
	function usable(list: { any }): { any }
		local out = {}
		for _, k in list or {} do
			if not k.blocked then
				table.insert(out, k)
			end
		end
		if #out == 0 then
			table.insert(out, { id = "bottle", name = "Bottle", cost = { bottles = 1, corks = 1 }, items = 1 })
		end
		return out
	end

	-- The crops the player holds seeds for.
	function seedList(v: any): { string }
		local out = {}
		for k, n in v.seeds or {} do
			if n > 0 then
				table.insert(out, k)
			end
		end
		table.sort(out)
		return out
	end

	-- One letter for each hand the player could copy.
	function forgeable(v: any): { any }
		local out, seen = {}, {}
		for _, l in v.shelf do
			if l.canForge and not seen[l.hand] then
				seen[l.hand] = true
				table.insert(out, l)
			end
		end
		return out
	end

	local function renderBeach(col: Frame, v: any)
		local sea = make("Frame", { BackgroundColor3 = SEA, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0), Parent = col, LayoutOrder = 1 }, { corner(10), pad(12) })
		local sc = column({ Parent = sea }, 6)
		if #v.beach == 0 then
			small("Nothing on the sand right now. Watch the wet sand as the tide goes out.", { TextColor3 = Color3.fromHex("#d9eef7"), Parent = sc, LayoutOrder = 1 })
		end
		for i, b in v.beach do
			local what = if b.strange then "A cold bottle with no seal" elseif b.old then "An old, barnacled bottle" else (VESSELS[b.kind] or "A bottle")
			button(what .. " on your " .. b.shore .. " beach. Open it", function()
				local res = ask("open", { id = b.id })
				if res and res.opened then
					if res.got and #res.got > 0 then
						ui.note = "Inside with the letter: " .. Bridge.list(res.got) .. "."
					end
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
			-- Their letter stays in view above yours while you write back, in their own hand.
			local l = ui.replyTo
			local top = column({ Parent = col, LayoutOrder = 1 }, 6)
			small("Answering the letter from your " .. l.shore .. " beach. Throw back the way it came and it may find its way home.", { Parent = top, LayoutOrder = 1 })
			local theirs = make("ScrollingFrame", {
				Name = "ReplyLetter", BackgroundColor3 = PAPER, BackgroundTransparency = 0.08, BorderSizePixel = 0, Size = UDim2.new(1, 0, 0, 130),
				CanvasSize = UDim2.new(), AutomaticCanvasSize = Enum.AutomaticSize.Y, ScrollBarThickness = 6, Parent = top, LayoutOrder = 2,
			}, { corner(4), pad(10) })
			local inner = column({ Parent = theirs }, 4)
			local lfont, link = Bridge.hand(l.hand)
			label(text(v, l.text) or l.body or "", { Font = (Enum.Font :: any)[lfont], TextSize = 17, TextColor3 = Color3.fromHex(link), Parent = inner, LayoutOrder = 1 })
			local name = text(v, l.name)
			if name then
				label("— " .. name, { Font = (Enum.Font :: any)[lfont], TextSize = 16, TextColor3 = Color3.fromHex(link), TextXAlignment = Enum.TextXAlignment.Right, Parent = inner, LayoutOrder = 2 })
			end
			local added = l.added and text(v, l.added.text)
			if added then
				local afont, aink = Bridge.hand(l.added.hand)
				label(added, { Font = (Enum.Font :: any)[afont], TextSize = 16, TextColor3 = Color3.fromHex(aink), Parent = inner, LayoutOrder = 3 })
			end
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
		if #v.journal > 0 and v.builds.desk then
			local p = v.journal[ui.page]
			chip("Fold in a page: " .. (if p then p.title else "none"), function()
				ui.page = (ui.page + 1) % (#v.journal + 1)
				render()
			end, { Parent = opts, LayoutOrder = 3 })
		end
		local kinds = usable(v.containers)
		local kind = kinds[ui.kind] or kinds[1]
		if #kinds > 1 then
			chip("Send it in: " .. kind.name, function()
				ui.kind = ui.kind % #kinds + 1
				render()
			end, { Parent = opts, LayoutOrder = 4 })
		end
		if v.seal.ring then
			chip((if ui.wax then "✓ " else "") .. "Seal it in wax", function()
				ui.wax = not ui.wax
				render()
			end, { Parent = opts, LayoutOrder = 5 })
		end
		if v.stamp then
			chip((if ui.stamp then "✓ " else "") .. "Press your stamp", function()
				ui.stamp = not ui.stamp
				render()
			end, { Parent = opts, LayoutOrder = 6 })
		end
		if (v.materials.shimmer or 0) > 0 then
			chip((if ui.shimmer then "✓ " else "") .. "Shimmering ink", function()
				ui.shimmer = not ui.shimmer
				render()
			end, { Parent = opts, LayoutOrder = 7 })
		end
		local hands = forgeable(v)
		if #hands > 0 then
			local h = hands[ui.forge]
			chip("Hand: " .. (if h then (text(v, h.name) or "the hand of hand " .. (h.handOf and h.handOf.mark or "?")) else "my own"), function()
				ui.forge = (ui.forge + 1) % (#hands + 1)
				render()
			end, { Parent = opts, LayoutOrder = 8 })
		end
		small(kind.name .. ": " .. Bridge.costWords(kind.cost) .. ". " .. (kind.words or ""), { Parent = col, LayoutOrder = 4 })
		local things = row({ Parent = col, LayoutOrder = 4 })
		local curio = v.curios[ui.curio]
		chip("Curio: " .. (if curio then curio.name else "none"), function()
			ui.curio = (ui.curio + 1) % (#v.curios + 1)
			render()
		end, { Parent = things, LayoutOrder = 1 })
		local seeds = seedList(v)
		if #seeds > 0 then
			local sd = seeds[ui.seeds]
			chip("Seeds: " .. (if sd then v.crops[sd].seed else "none"), function()
				ui.seeds = (ui.seeds + 1) % (#seeds + 1)
				render()
			end, { Parent = things, LayoutOrder = 2 })
		end
		if v.builds.desk then
			chip((if ui.map then "✓ " else "") .. "A copy of my chart", function()
				ui.map = not ui.map
				render()
			end, { Parent = things, LayoutOrder = 3 })
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
			local p = if v.builds.desk then v.journal[ui.page] else nil
			local dir = ui.dir
			local items = {}
			if v.curios[ui.curio] then
				table.insert(items, { kind = "curio", index = ui.curio - 1 })
			end
			local sd = seedList(v)[ui.seeds]
			if sd then
				table.insert(items, { kind = "seeds", crop = sd })
			end
			if ui.map and v.builds.desk then
				table.insert(items, { kind = "map" })
			end
			local h = forgeable(v)[ui.forge]
			local res = ask("throw", {
				text = ui.letter, dir = dir, strength = Bridge.STRENGTHS[ui.strength].value, signed = ui.signed,
				glue = ui.glue and kind.id == "bottle", page = p and p.id, replyTo = ui.replyTo and ui.replyTo.id,
				kind = kind.id, items = items, wax = ui.wax, stamp = ui.stamp and v.stamp ~= nil, shimmer = ui.shimmer, forge = h and h.id,
			})
			if res then
				ui.letter, ui.dir, ui.replyTo, ui.glue, ui.page = "", nil, nil, false, 0
				ui.curio, ui.seeds, ui.map, ui.wax, ui.shimmer, ui.forge, ui.kind = 0, 0, false, false, false, 0, 1
				ui.note = "Your " .. (if kind.id == "bottle" then "bottle" else string.lower(kind.name)) .. " bobs away to the " .. Bridge.DIR_WORDS[dir + 1] .. "."
					.. (if res.lostRing then " As it goes, you feel your seal ring slip off your wet finger and into the waves." else "")
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

	local function renderIsland(col: Frame, v: any)
		local _, m = card({ Parent = col, LayoutOrder = 1 })
		heading("Materials", { Parent = m, LayoutOrder = 1 })
		local names = {}
		for k in v.materials do
			table.insert(names, k)
		end
		table.sort(names)
		if #names == 0 then
			small("Nothing yet. The tide brings driftwood and rope.", { Parent = m, LayoutOrder = 2 })
		end
		for i, k in names do
			pair(m, Bridge.MATERIAL_NAMES[k] or k, tostring(v.materials[k]), 1 + i)
		end
		small(if v.kit.gathered then "You have gathered all you can carry this tide." else "Once a tide you can gather inland:", { Parent = col, LayoutOrder = 2 })
		local g = row({ Parent = col, LayoutOrder = 3 })
		for i, what in Bridge.GATHER do
			chip(Bridge.GATHER_NAMES[i], function()
				doing("gather", { what = what }, "You gather two loads of " .. string.lower(Bridge.GATHER_NAMES[i]) .. ".")
			end, { Parent = g, LayoutOrder = i }, if v.kit.gathered then "secondary" else "primary")
		end
		heading("Garden", { TextSize = 14, Parent = col, LayoutOrder = 4 })
		local seeds = seedList(v)
		for i, p in v.garden do
			local plot = i - 1
			if p.locked then
				small("Room for another plot, once you build garden beds.", { Parent = col, LayoutOrder = 4 + i })
			elseif not p.crop then
				if #seeds > 0 then
					local r = row({ Parent = col, LayoutOrder = 4 + i })
					small("Plot " .. i .. " is empty. Plant:", { Parent = r, LayoutOrder = 0 })
					for j, crop in seeds do
						chip(v.crops[crop].name .. " (" .. v.seeds[crop] .. ")", function()
							doing("plant", { plot = plot, crop = crop }, "Planted. Water it every tide or two.")
						end, { Parent = r, LayoutOrder = j }, "secondary")
					end
				else
					small("Plot " .. i .. " is empty.", { Parent = col, LayoutOrder = 4 + i })
				end
			elseif p.ripe then
				button(p.name .. " is ready. Harvest it", function()
					doing("harvest", { plot = plot }, function(res)
						return "You harvest " .. tostring(res.done) .. ", and keep a seed back."
					end)
				end, { Parent = col, LayoutOrder = 4 + i })
			else
				label(p.name .. ": " .. p.growth .. " of " .. p.needs .. " tides" .. (if p.dry then ", needs water" else ""), {
					TextColor3 = if p.dry then WARN else Ui.FG, Parent = col, LayoutOrder = 4 + i,
				})
			end
		end
		button("Water the garden", function()
			doing("water", nil, "You carry water up from the stream.")
		end, { Parent = col, LayoutOrder = 10 }, "secondary")
		small("Crops only grow while watered: once every two tides is enough. Berries make ink and bait, reeds paper, cork oak corks, and bee flowers wax.", { Parent = col, LayoutOrder = 11 })
	end

	local function renderBuild(col: Frame, v: any)
		heading("Build", { TextSize = 14, Parent = col, LayoutOrder = 1 })
		for i, b in v.blueprints do
			local done = b.built >= b.stages
			local name = b.name .. (if b.stages > 1 then " (" .. b.built .. "/" .. b.stages .. ")" else "") .. (if done then " ✓" else "")
			if b.next then
				button("Build: " .. b.next.name .. " (" .. Bridge.costWords(b.next.cost) .. ")", function()
					doing("build", { what = b.id }, function(res)
						return "You build the " .. string.lower(tostring(res.done)) .. "."
					end)
				end, { Parent = col, LayoutOrder = 1 + i * 2 }, if b.next.ok then "primary" else "secondary")
			else
				label(name, { TextColor3 = if done then ACCENT else MUTED, Parent = col, LayoutOrder = 1 + i * 2 })
			end
			small(b.words .. (if b.blocked and not done then " " .. b.blocked else ""), { Parent = col, LayoutOrder = 2 + i * 2 })
		end
		heading("Make", { TextSize = 14, Parent = col, LayoutOrder = 100 })
		local order = 100
		for _, r in v.recipes do
			if r.blocked == "Made." or r.hidden then
				continue
			end
			order += 2
			button(r.name .. " (" .. Bridge.costWords(r.cost) .. ")", function()
				doing("make", { what = r.id, pattern = if r.id == "stamp" then ui.pattern else nil }, function(res)
					return "Done: " .. string.lower(tostring(res.done)) .. "."
				end)
			end, { Parent = col, LayoutOrder = order }, if r.ok and not r.blocked then "primary" else "secondary")
			if r.blocked then
				small(r.blocked, { Parent = col, LayoutOrder = order + 1 })
			end
			if r.id == "stamp" and not r.blocked then
				chip("Pattern: " .. v.stamps[ui.pattern + 1], function()
					ui.pattern = (ui.pattern + 1) % #v.stamps
					render()
				end, { Parent = col, LayoutOrder = order + 1 }, "secondary")
			end
		end
		if v.builds.bench then
			heading("Your seal", { TextSize = 14, Parent = col, LayoutOrder = 200 })
			local glyph = ui.glyph or v.seal.glyph
			local wax = ui.waxColour or v.seal.wax
			small(if v.seal.ring then "You have a seal ring. Letters sealed with it cost a little wax."
				elseif v.seal.designed then "You lost your seal ring. Cut a new one."
				else "Design your own crest, and cut it into a ring to seal letters with.", { Parent = col, LayoutOrder = 201 })
			local r = row({ Parent = col, LayoutOrder = 202 })
			chip("Mark: " .. Bridge.GLYPHS[glyph + 1], function()
				ui.glyph = (glyph + 1) % #Bridge.GLYPHS
				render()
			end, { Parent = r, LayoutOrder = 1 }, "secondary")
			chip("Wax: " .. Bridge.WAX_NAMES[wax + 1], function()
				ui.waxColour = (wax + 1) % #Bridge.WAX
				render()
			end, { Parent = r, LayoutOrder = 2 }, "secondary")
			button("Cut a seal ring", function()
				doing("seal", { glyph = glyph, wax = wax }, "You cut your crest into a ring.")
			end, { Parent = col, LayoutOrder = 203 })
		end
	end

	-- The fishing minigame. The server has already decided what is down there and how it fights;
	-- this plays it out with timers and sends back when the player struck and how they answered.
	local function endFishing(words: string)
		ui.fishing = nil
		ui.note = words
		render()
	end

	local function reel(strikeAt: number)
		local f = ui.fishing
		if not f or f.phase == "done" then
			return
		end
		f.phase = "done"
		local res = ask("reel", { strike = strikeAt, answers = f.answers })
		if res then
			endFishing(if res.caught == "nothing" or res.caught == nil then (res.lost or "It got away.") else "You land " .. res.caught .. ".")
		else
			endFishing("")
		end
	end

	local function say(words: string, urgent: boolean?)
		ui.fishing.say = words
		ui.fishing.urgent = urgent == true
		render()
	end

	local function nextPull()
		local f = ui.fishing
		if not f or f.phase ~= "fight" then
			return
		end
		if f.round > #f.line.runs then
			reel(f.line.nibbles)
			return
		end
		local round = f.round
		f.pull = f.line.runs[round]
		say(Bridge.PULL_WORDS[f.pull], true)
		task.delay(Bridge.PULL_SECONDS, function()
			if ui.fishing == f and f.round == round and f.pull then
				answer("none")
			end
		end)
	end

	-- One answer per pull: presses between pulls count for nothing.
	function answer(a: string)
		local f = ui.fishing
		if not f or f.phase ~= "fight" or not f.pull then
			return
		end
		table.insert(f.answers, a)
		f.round += 1
		f.pull = nil
		say(if a == "none" then "Too slow! The line strains…" else "You hold on…", false)
		task.delay(0.5, nextPull)
	end

	function strike()
		local f = ui.fishing
		if not f or f.phase ~= "wait" then
			return
		end
		-- Struck while nothing was pulling counts as striking at a nibble.
		local on = if f.dipping then f.dips - 1 else -1
		if on ~= f.line.nibbles then
			reel(on)
			return
		end
		f.phase = "fight"
		f.round = 1
		say("Hooked! Hold on…", true)
		task.delay(0.6, nextPull)
	end

	local function dip(deep: boolean)
		local f = ui.fishing
		if not f or f.phase ~= "wait" then
			return
		end
		f.dips += 1
		f.dipping = true
		local index = f.dips
		say(if deep then "The float goes right under!" else "The float dips…", deep)
		task.delay(if deep then Bridge.BITE_SECONDS else Bridge.NIBBLE_SECONDS, function()
			if ui.fishing ~= f or f.dips ~= index or f.phase ~= "wait" then
				return
			end
			f.dipping = false
			if deep then
				reel(f.line.nibbles + 1) -- too slow: it spat the hook
			else
				say("The float settles again. Watch it…")
			end
		end)
	end

	function castAt(spot: string)
		if ui.fishing then
			return
		end
		local res = ask("cast", { spot = spot, bait = ui.bait })
		if not res or not res.line then
			return
		end
		ui.bait = false
		local f = { line = res.line, phase = "wait", dips = 0, dipping = false, answers = {}, say = "The float settles on the water. Watch it…" }
		ui.fishing = f
		render()
		if not res.line.bite then
			task.delay(4 + math.random() * 2.5, function()
				if ui.fishing == f then
					endFishing("Nothing so much as nibbles here. You reel the line back in.")
				end
			end)
			return
		end
		local t = 1.2 + math.random() * 1.5
		for _ = 1, res.line.nibbles do
			task.delay(t, dip, false)
			t += 1.3 + math.random() * 1.8
		end
		task.delay(t, dip, true)
	end

	local function renderFishing(col: Frame, v: any)
		local kit = v.kit
		local _, c = card({ Parent = col, LayoutOrder = 1 })
		heading("Your catch", { Parent = c, LayoutOrder = 1 })
		pair(c, "Fish", tostring(kit.fish), 2)
		pair(c, "Bones", tostring(kit.bones), 3)
		pair(c, "Fish glue", tostring(kit.glue), 4)
		pair(c, "Hook", if kit.hook then "bone" else "nail", 5)
		local f = ui.fishing
		if f then
			-- The minigame: watch the float, strike on the real bite, then answer each pull.
			-- It sits at the top of the tab, with the float drawn right above the buttons, so the
			-- float and the controls are always on screen together.
			local box = make("Frame", { BackgroundColor3 = SEA, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0), Parent = col, LayoutOrder = 0 }, { corner(8), pad(10) })
			local bc = column({ Parent = box }, 8)
			local water = make("Frame", { Name = "FloatView", BackgroundColor3 = Color3.fromHex("#1d4e6b"), Size = UDim2.new(1, 0, 0, 90), ClipsDescendants = true, Parent = bc, LayoutOrder = 0 }, { corner(6) })
			local dx, dy, size = 0, 0, 16
			if f.phase == "wait" and f.dipping then
				local deep = f.dips > f.line.nibbles
				dy, size = if deep then 18 else 8, if deep then 6 else 12
				make("Frame", { Name = "Ring", AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.new(0.5, 0, 0.5, dy), Size = UDim2.fromOffset(if deep then 52 else 30, if deep then 52 else 30), BackgroundTransparency = 1, Parent = water }, { corner(30), make("UIStroke", { Color = Color3.new(1, 1, 1), Transparency = 0.3, Thickness = 2 }) })
			elseif f.phase == "fight" and f.pull then
				dx = if f.pull == "left" then -90 elseif f.pull == "right" then 90 else 0
				dy, size = if f.pull == "away" then 20 else 0, if f.pull == "away" then 6 else 12
				local wake = if f.pull == "left" then "≫≫" elseif f.pull == "right" then "≪≪" else "◎"
				make("TextLabel", { Name = "Wake", AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.new(0.5, dx + (if f.pull == "left" then 36 elseif f.pull == "right" then -36 else 0), 0.5, dy), Size = UDim2.fromOffset(60, 30), BackgroundTransparency = 1, Text = wake, TextColor3 = Color3.new(1, 1, 1), TextTransparency = 0.3, TextScaled = true, Parent = water })
			end
			make("Frame", { Name = "Float", AnchorPoint = Vector2.new(0.5, 0.5), Position = UDim2.new(0.5, dx, 0.5, dy), Size = UDim2.fromOffset(size, size), BackgroundColor3 = Color3.fromHex("#e04a3a"), Parent = water }, { corner(size) })
			label(f.say, { TextColor3 = if f.urgent then WARN else Color3.fromHex("#d9eef7"), Font = Enum.Font.GothamBold, Parent = bc, LayoutOrder = 1 })
			if f.phase == "wait" then
				button("Strike!", function()
					strike()
				end, { Parent = bc, LayoutOrder = 2 })
			elseif f.phase == "fight" then
				local r = row({ Parent = bc, LayoutOrder = 2 })
				for i, a in { { "left", "← Lean left" }, { "give", "↓ Give line" }, { "right", "Lean right →" } } do
					chip(a[2], function()
						answer(a[1])
					end, { Parent = r, LayoutOrder = i }, if f.pull then "primary" else "secondary")
				end
			end
		else
			small(if kit.casts < 1 then "The fish have gone quiet. Try again next tide." else "Casts left this tide: " .. kit.casts .. ". Read the water, then pick where to cast:", { Parent = col, LayoutOrder = 2 })
			for i, sp in kit.spots or {} do
				button(sp.name .. "\n" .. sp.sign, function()
					if kit.casts >= 1 then
						castAt(sp.id)
					end
				end, { Parent = col, LayoutOrder = 2, Name = "Spot" .. i, TextXAlignment = Enum.TextXAlignment.Left }, if kit.casts < 1 then "secondary" else "primary")
			end
		end
		if (v.materials.berries or 0) > 0 then
			chip((if ui.bait then "✓ " else "") .. "Bait the hook with a berry", function()
				ui.bait = not ui.bait
				render()
			end, { Parent = col, LayoutOrder = 2 })
		end
		if kit.spear then
			button(if kit.canSpear then "Wade out with the spear" elseif kit.lowTide then "Speared this tide" else "Spear (wait for low tide)", function()
				if kit.canSpear then
					doing("spear", nil, function(res)
						return if res.caught == "nothing" or res.caught == nil then "You wade back with nothing." else "You spear something."
					end)
				end
			end, { Parent = col, LayoutOrder = 3 }, if kit.canSpear then "primary" else "secondary")
		end
		if (v.materials.traps or 0) > 0 and #kit.traps < kit.maxTraps then
			button("Set a baited trap", function()
				doing("trap", nil, "You bait a trap with a berry and wedge it between the rocks.")
			end, { Parent = col, LayoutOrder = 3 }, "secondary")
		end
		if #kit.traps > 0 then
			button("Pull up the traps (" .. #kit.traps .. " set)", function()
				doing("traps", nil, "You pull up the traps.")
			end, { Parent = col, LayoutOrder = 3 }, "secondary")
		end
		if kit.snag then
			small("A bottle is tangled in your line, still on its way to someone.", { Parent = col, LayoutOrder = 4 })
			local r = row({ Parent = col, LayoutOrder = 4 })
			chip("Keep it", function()
				doing("snag", { keep = true }, "You pull the bottle in. It is on your beach now.")
			end, { Parent = r, LayoutOrder = 1 }, "primary")
			chip("Let it drift on", function()
				doing("snag", { keep = false }, "You untangle it and let it drift on its way.")
			end, { Parent = r, LayoutOrder = 2 }, "secondary")
		end
		small("One spot is lively each tide, and the water shows which. Little dips are only nibbles: strike when the float goes right under. Then lean against each run, and give it line when it dives. Dawn, dusk, a rising tide and bait all help; make a hook, spear and traps at a workshop (Build tab).", { Parent = col, LayoutOrder = 5 })
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
		for i, k in v.clues or {} do
			label(k.text, { TextColor3 = WARN, Parent = col, LayoutOrder = 30 + i * 2 })
			small("A clue from a strange bottle. It goes stale " .. Bridge.untilText(v.now, k["until"]) .. ".", { Parent = col, LayoutOrder = 31 + i * 2 })
		end
		heading("Your chart", { TextSize = 14, Parent = col, LayoutOrder = 60 })
		if not v.builds.desk then
			small("Build a writing desk to keep a chart of who writes to you.", { Parent = col, LayoutOrder = 61 })
		elseif #v.chart == 0 then
			small("Signed letters you find mark your chart, by the beach they wash up on.", { Parent = col, LayoutOrder = 61 })
		end
		local pals = {}
		for _, p in v.pals or {} do
			pals[p] = true
		end
		for i, c in v.chart do
			label((text(v, c.name) or "Someone") .. ": off your " .. c.shore .. " beach, " .. c.letters .. " letter" .. (if c.letters == 1 then "" else "s")
				.. (if pals[c.name] then " (pen pal)" else ""), { Parent = col, LayoutOrder = 61 + i })
		end
		if v.neighbours > 0 then
			small("At night you can see " .. v.neighbours .. " fire" .. (if v.neighbours == 1 then "" else "s") .. " on the horizon.", { Parent = col, LayoutOrder = 90 })
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
		heading("Letters you've found (" .. v.held .. " of " .. v.room .. ")", { TextSize = 14, Parent = col, LayoutOrder = 1 })
		if #v.shelf == 0 then
			small("Nothing yet. Watch the wet sand as the tide goes out.", { Parent = col, LayoutOrder = 2 })
		elseif v.shelfCount > #v.shelf then
			small("The newest " .. #v.shelf .. " of " .. v.shelfCount .. ".", { Parent = col, LayoutOrder = 2 })
		end
		for i, l in v.shelf do
			local body = text(v, l.text) or l.body or ""
			local what = if l.strange then "A bottle with no seal: " .. Bridge.firstLine(body)
				elseif l.old then "An old journal page: " .. (l.title or Bridge.firstLine(body))
				elseif l.own then "Your own letter, back again: " .. Bridge.firstLine(body)
				else Bridge.firstLine(body)
			button(what .. "\n" .. l.shore .. " beach, " .. Bridge.ago(v.now, l.landed), function()
				readLetter(l)
			end, { Parent = col, LayoutOrder = 2 + i, TextXAlignment = Enum.TextXAlignment.Left }, "secondary")
		end
		heading("Bottles you've thrown", { TextSize = 14, Parent = col, LayoutOrder = 100 })
		if v.marks.kind > 0 or v.marks.useful > 0 then
			small("The sea has heard that " .. v.marks.kind .. " of your letters were kind and " .. v.marks.useful .. " were useful.", { Parent = col, LayoutOrder = 99 })
		end
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
		elseif ui.tab == "island" then
			renderIsland(body, v)
		elseif ui.tab == "build" then
			renderBuild(body, v)
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
