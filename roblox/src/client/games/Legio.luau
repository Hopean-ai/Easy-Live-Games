-- The Legio screens: one soldier's career, a card at a time, beside his standing and the ladder,
-- with the leaderboard on its own tab. Legio is played alone on the website, with no rooms, so the
-- hub opens these straight from the picker. Every request goes through the hub's server as
-- "world". The career is the player's linked account's, or one of their own.
return function(hub: any)
	local Ui, Bridge, state, ui, root = hub.Ui, hub.bridge, hub.state, hub.ui, hub.root
	local call, render, errorLine, confirmButton = hub.call, hub.render, hub.errorLine, hub.confirmButton
	local make, corner, pad, label, heading, small = Ui.make, Ui.corner, Ui.pad, Ui.label, Ui.heading, Ui.small
	local button, chip, column, row, card, pair = Ui.button, Ui.chip, Ui.column, Ui.row, Ui.card, Ui.pair
	local MUTED = Ui.MUTED
	local GOLD = Color3.fromHex("#d4a24c")
	local BLOOD = Color3.fromHex("#9b2c2c")

	local TABS = { { id = "career", name = "Career" }, { id = "ladder", name = "Standing" }, { id = "board", name = "Leaderboard" } }

	local function reset()
		ui.view = nil
		ui.tab = "career"
		ui.loading = false
	end

	-- Sends one request to the camp and keeps the view it answers with.
	local function ask(op: string, fields: { [string]: any }?): any
		local arg = { game = Bridge.ID, op = op }
		for k, v in fields or {} do
			arg[k] = v
		end
		local res = call("world", arg)
		if res and res.view then
			ui.view = res.view
			if res.view.note then
				state.error = res.view.note
			end
			render()
		end
		return res and res.view
	end

	local function renderIntro(col: Frame, v: any)
		local _, c = card({ Parent = col, LayoutOrder = 1 })
		heading("235 AD. The army has just murdered its emperor.", { Parent = c, LayoutOrder = 1 })
		label("You are eighteen, a Roman citizen, and the recruiting officer is waiting. Enlist as a recruit and climb the real ranks of a legion: legionary, centurion, primus pilus, legate, general, and perhaps emperor, if you live. Death ends the career.", { Parent = c, LayoutOrder = 2 })
		button("Enlist", function()
			ask("enlist")
		end, { Parent = c, LayoutOrder = 3 })
		if v.best then
			small("Your best: " .. v.best.name .. ", " .. v.best.rank .. ", " .. v.best.score .. " points, over " .. v.careers .. (if v.careers == 1 then " career." else " careers."), { Parent = col, LayoutOrder = 2 })
		end
	end

	local function renderEnded(col: Frame, run: any)
		local _, c = card({ Parent = col, LayoutOrder = 1 })
		heading("Your career is over", { TextColor3 = GOLD, Parent = c, LayoutOrder = 1 })
		label(run.fate or "", { Font = Enum.Font.GothamMedium, Parent = c, LayoutOrder = 2 })
		label("Score: " .. run.score, { Font = Enum.Font.GothamBold, TextSize = 18, Parent = c, LayoutOrder = 3 })
		for i, line in run.story or {} do
			small(line, { TextSize = 13, Parent = c, LayoutOrder = 10 + i })
		end
		button("Enlist again", function()
			ask("enlist")
		end, { Parent = c, LayoutOrder = 200 })
	end

	local function renderCard(col: Frame, run: any)
		local f = make("Frame", { BackgroundColor3 = Ui.PANEL2, AutomaticSize = Enum.AutomaticSize.Y, Size = UDim2.new(1, 0, 0, 0), Parent = col, LayoutOrder = 1 }, { corner(8), Ui.stroke(BLOOD, 2), pad(12) })
		local c = column({ Parent = f }, 8)
		heading(run.card.title, { TextSize = 18, Parent = c, LayoutOrder = 1 })
		label(run.card.text, { Parent = c, LayoutOrder = 2 })
		for i, choice in run.card.choices do
			local text = choice.label .. (if choice.hint then "  ·  " .. choice.hint .. (if choice.off then " (not now)" else "") else "")
			local b = button(text, function()
				if choice.off or ui.loading then
					return
				end
				ui.loading = true
				state.error = nil
				ask("choose", { i = i - 1, turn = run.turn })
				ui.loading = false
			end, { Parent = c, LayoutOrder = 10 + i, TextXAlignment = Enum.TextXAlignment.Left }, if choice.off then "link" else "secondary")
			if choice.off then
				b.TextColor3 = MUTED
			end
		end
		-- The latest of the log, newest first.
		local log = run.log or {}
		if #log > 0 then
			heading("Recent days", { TextSize = 14, TextColor3 = GOLD, Parent = col, LayoutOrder = 2 })
			for n = 1, math.min(6, #log) do
				local entry = log[#log - n + 1]
				small(Bridge.when(entry) .. "  " .. entry.text, { TextSize = 13, Parent = col, LayoutOrder = 2 + n })
			end
		end
	end

	local function renderStanding(col: Frame, run: any)
		local _, c = card({ Parent = col, LayoutOrder = 1 })
		local rank = run.ranks[run.rank + 1]
		heading(run.name, { TextColor3 = GOLD, Parent = c, LayoutOrder = 1 })
		small(rank.name .. ": " .. rank.gloss, { TextSize = 13, Parent = c, LayoutOrder = 2 })
		pair(c, "Legion", (run.legion or "—") .. (if run.base then ", " .. run.base else ""), 3)
		pair(c, "Front", run.front or "—", 4)
		pair(c, "Emperor", run.emperor, 5)
		pair(c, "Age", tostring(run.age), 6)
		pair(c, "Service", Bridge.years(run.years) .. " · " .. run.season .. ", " .. run.year .. " AD", 7)
		pair(c, "Purse", run.denarii .. " denarii" .. (if run.debt and run.debt > 0 then " (owes " .. run.debt .. ")" else ""), 8)
		pair(c, "Score", tostring(run.score), 9)
		local _, s = card({ Parent = col, LayoutOrder = 2 })
		heading("Standing", { TextSize = 14, TextColor3 = GOLD, Parent = s, LayoutOrder = 1 })
		pair(s, "Health", tostring(math.floor(run.health + 0.5)), 2, true)
		for i, stat in Bridge.STATS do
			if not stat.officer or run.officer then
				pair(s, stat.name, tostring(math.floor(run.stats[stat.key] + 0.5)), 2 + i * 2, true)
				small(stat.gloss, { Parent = s, LayoutOrder = 3 + i * 2 })
			end
		end
		local _, l = card({ Parent = col, LayoutOrder = 3 })
		heading("The ladder", { TextSize = 14, TextColor3 = GOLD, Parent = l, LayoutOrder = 1 })
		for i = #run.ranks, 1, -1 do
			local r = run.ranks[i]
			local now = i == run.rank + 1
			local reached = i <= run.best + 1
			label((if now then "▶ " else "") .. r.name .. "  ·  " .. r.gloss, {
				TextSize = 13, Font = if now then Enum.Font.GothamBold else Enum.Font.Gotham,
				TextColor3 = if now then GOLD elseif reached then Ui.FG else MUTED, Parent = l, LayoutOrder = 100 - i,
			})
		end
		if run.decorations and #run.decorations > 0 then
			local _, d = card({ Parent = col, LayoutOrder = 4 })
			heading("Decorations", { TextSize = 14, TextColor3 = GOLD, Parent = d, LayoutOrder = 1 })
			for i, name in run.decorations do
				small(name, { TextSize = 13, Parent = d, LayoutOrder = 1 + i })
			end
		end
	end

	local function renderBoard(col: Frame, v: any)
		local _, c = card({ Parent = col, LayoutOrder = 1 })
		heading("The leaderboard", { TextColor3 = GOLD, Parent = c, LayoutOrder = 1 })
		small("Every finished career, on Roblox and the website, best first.", { Parent = c, LayoutOrder = 2 })
		if #v.leaderboard == 0 then
			label("Nobody has finished a career yet.", { Parent = c, LayoutOrder = 3 })
		end
		for i, r in v.leaderboard do
			label(i .. ". " .. r.name .. (if r.you then " (you)" else "") .. "  ·  " .. r.rank .. "  ·  " .. r.score .. " points", {
				Font = if r.you then Enum.Font.GothamBold else Enum.Font.GothamMedium, TextSize = 14,
				TextColor3 = if r.you then GOLD else Ui.FG, Parent = c, LayoutOrder = 10 + i * 2,
			})
			small(r.fate, { Parent = c, LayoutOrder = 11 + i * 2 })
		end
		small(if v.best then "Your best: " .. v.best.name .. ", " .. v.best.rank .. ", " .. v.best.score .. " points." else "Finish a career to get on the board.", { Parent = c, LayoutOrder = 200 })
	end

	local function renderScreen(_view: any)
		-- The career is asked for once, when the screens open.
		if not ui.view and not ui.loading and not state.error then
			ui.loading = true
			task.spawn(function()
				ask("state")
				ui.loading = false
			end)
			if ui.view then
				return -- already drawn by the answer
			end
		end
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
			state.game = nil
			state.error = nil
			render()
		end, { Parent = top, LayoutOrder = 1 }, "link")
		label("Legio", { Font = Enum.Font.GothamBold, TextSize = 28, TextColor3 = GOLD, Parent = col, LayoutOrder = 2 })
		local v = ui.view
		if not v then
			small(if state.error then "The camp could not be reached." else "Marching into camp…", { Parent = col, LayoutOrder = 3 })
			if state.error then
				button("Try again", function()
					state.error = nil
					ask("state")
				end, { Parent = col, LayoutOrder = 4 }, "secondary")
			end
			errorLine(col, 5)
			return
		end
		local run = v.run
		small(if run and run.name ~= "" then run.name .. " · " .. run.ranks[run.rank + 1].name .. " · " .. run.year .. " AD" else "From recruit to emperor, if you live.", { TextSize = 14, Parent = col, LayoutOrder = 3 })
		errorLine(col, 4)
		local tabs = row({ Parent = col, LayoutOrder = 5 })
		for i, t in TABS do
			if t.id ~= "ladder" or (run and not run.over) then
				chip(t.name, function()
					ui.tab = t.id
					state.error = nil
					render()
				end, { Parent = tabs, LayoutOrder = i }, if ui.tab == t.id then "primary" else "secondary")
			end
		end
		local body = column({ Parent = col, LayoutOrder = 10 }, 8)
		if ui.tab == "board" then
			renderBoard(body, v)
		elseif not run then
			renderIntro(body, v)
		elseif run.over then
			renderEnded(body, run)
		elseif ui.tab == "ladder" then
			renderStanding(body, run)
		else
			renderCard(body, run)
		end
		if run and not run.over then
			confirmButton("legio-again", "Give up this career and enlist again", function()
				ask("enlist")
			end, { Parent = col, LayoutOrder = 20 }, "secondary")
			small("A career given up never reaches the leaderboard.", { Parent = col, LayoutOrder = 21 })
		end
	end

	return { render = renderScreen, reset = reset, world = true }
end
