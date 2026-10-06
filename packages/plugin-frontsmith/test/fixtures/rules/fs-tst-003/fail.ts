test("a", async ({ page }) => {
  await page.waitForTimeout(500);
  await expect(page).toHaveTitle("x");
});
