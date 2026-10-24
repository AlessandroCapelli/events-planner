const { test, expect, eventPath } = require("./fixtures.cjs");

test("a new draft typed while a submit succeeds is kept", async ({ page }) => {
	await page.goto(eventPath);
	const form = page.locator('form[data-submit="addItem"]');
	await form.locator("input").fill("Drinks");
	await page.evaluate(() => {
		window.__mock.holdItem = true;
	});
	await form.getByRole("button", { name: "Add", exact: true }).click();
	await page.waitForFunction(() => !!window.__mock.releaseItem);
	await form.locator("input").fill("Next thing to add");
	await page.evaluate(() => {
		window.__mock.emit();
		window.__mock.releaseItem();
	});
	await expect(page.locator(".items-card .rows")).toContainText("Drinks");
	await expect(form.locator("input")).toHaveValue("Next thing to add");
});

test("a successful insert is cleared even if the following refresh fails", async ({ page }) => {
	await page.goto(eventPath);
	const form = page.locator('form[data-submit="addItem"]');
	await form.locator("input").fill("Drinks");
	await page.evaluate(() => {
		window.__mock.failRefresh = true;
	});
	await form.getByRole("button", { name: "Add", exact: true }).click();
	await expect(form.locator("input")).toHaveValue("");
	await expect(page.locator(".rsvp")).toBeVisible();
	await page.evaluate(() => {
		window.__mock.failRefresh = false;
		window.__mock.emit();
	});
	await expect(page.locator(".items-card .rows")).toContainText("Drinks");
});

test("a submitted proposal is cleared while the item draft is kept", async ({ page }) => {
	await page.goto(eventPath);
	const item = page.locator('form[data-submit="addItem"] input');
	const form = page.locator('form[data-submit="propose"]');
	await item.fill("Unsent draft");
	await form.locator('[name="location"]').fill("Pizzeria");
	await form.getByRole("button", { name: "Propose", exact: true }).click();
	await expect(form.locator('[name="location"]')).toHaveValue("");
	await expect(page.locator(".proposals-card .rows")).toContainText("Pizzeria");
	await expect(item).toHaveValue("Unsent draft");
});

test("the password is cleared only after it was saved", async ({ page }) => {
	await page.goto("/#/account");
	const form = page.locator('form[data-submit="password"]');
	const submit = form.getByRole("button", { name: "Change password", exact: true });
	await form.locator('[name="password"]').fill("Test password");
	await form.locator('[name="confirm"]').fill("Test password");
	await page.evaluate(() => {
		window.__mock.failPassword = true;
	});
	await submit.click();
	await expect(form.locator(".form-error")).toHaveText(/Password not saved/);
	await expect(form.locator('[name="password"]')).toHaveValue("Test password");
	await page.evaluate(() => {
		window.__mock.failPassword = false;
	});
	await submit.click();
	await expect(form.locator('[name="password"]')).toHaveValue("");
	await expect(form.locator('[name="confirm"]')).toHaveValue("");
});

test("a new password typed while the previous one is being saved is kept", async ({ page }) => {
	await page.goto("/#/account");
	const form = page.locator('form[data-submit="password"]');
	await form.locator('[name="password"]').fill("First password");
	await form.locator('[name="confirm"]').fill("First password");
	await page.evaluate(() => {
		window.__mock.holdPassword = true;
	});
	await form.getByRole("button", { name: "Change password", exact: true }).click();
	await page.waitForFunction(() => !!window.__mock.releasePassword);
	await form.locator('[name="password"]').fill("Second password");
	await form.locator('[name="confirm"]').fill("Second password");
	await page.evaluate(() => window.__mock.releasePassword());
	await expect(form.getByRole("button", { name: "Change password", exact: true })).toBeEnabled();
	await expect(form.locator('[name="password"]')).toHaveValue("Second password");
	await expect(form.locator('[name="confirm"]')).toHaveValue("Second password");
});

test("creating a user clears the form and generates a new password", async ({ page }) => {
	await page.goto("/#/admin");
	await page.locator(".disclosure > summary").click();
	const form = page.locator('form[data-submit="create"]');
	await form.locator('[name="display_name"]').fill("New user");
	await form.locator('[name="email"]').fill("new@example.test");
	await form.locator('[name="groups"][value="default"]').check();
	const previousPassword = await form.locator('[name="password"]').inputValue();
	await form.getByRole("button", { name: "Create user", exact: true }).click();
	await expect(page.getByRole("dialog")).toBeVisible();
	expect(await page.evaluate(() => window.__mock.lastAdmin.groups)).toEqual(["default"]);
	await page.getByRole("dialog").getByRole("button", { name: "Done", exact: true }).click();
	await expect(form.locator('[name="display_name"]')).toHaveValue("");
	await expect(form.locator('[name="email"]')).toHaveValue("");
	await expect(form.locator('[name="password"]')).not.toHaveValue(previousPassword);
});

test("creating a user requires at least one group", async ({ page }) => {
	await page.goto("/#/admin");
	await page.locator(".disclosure > summary").click();
	const form = page.locator('form[data-submit="create"]');
	await form.locator('[name="display_name"]').fill("New user");
	await form.locator('[name="email"]').fill("new@example.test");
	await form.getByRole("button", { name: "Create user", exact: true }).click();
	await expect(form.locator(".field-error")).toContainText("Choose at least one group");
	expect(await page.evaluate(() => window.__mock.lastAdmin)).toBeUndefined();
});

test("changing an event group preserves the draft and updates its invitees", async ({ page }) => {
	await page.goto("/#/new");
	const form = page.locator('form[data-submit="save"]');
	await form.locator('[name="title"]').fill("Unsent dinner");
	await form.locator('[name="audience"][value="invited"]').check();
	await form.locator('[name="invitees"][value="long"]').check();
	await form.locator('[name="group_id"]').selectOption("climbing");
	await expect(form.locator('[name="invitees"][value="long"]')).toHaveCount(0);
	await expect(form.locator('[name="title"]')).toHaveValue("Unsent dinner");
	await expect(form.locator('[name="audience"][value="invited"]')).toBeChecked();
	await expect(form.locator('[name="group_id"]')).toHaveValue("climbing");
	await form.locator('[name="group_id"]').selectOption("default");
	await expect(form.locator('[name="invitees"][value="long"]')).toBeVisible();
	await expect(form.locator('[name="group_id"]')).toHaveValue("default");
	await expect(form.locator('[name="title"]')).toHaveValue("Unsent dinner");
});
