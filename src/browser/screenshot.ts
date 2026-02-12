import { Page } from "playwright";

/**
 * Default viewport size for consistent screenshots
 */
export const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

/**
 * Capture a screenshot of the current page
 */
export async function captureScreenshot(page: Page): Promise<Buffer> {
  return await page.screenshot({
    type: "png",
    fullPage: false,
    timeout: 30000,
  });
}

/**
 * Get the current viewport size
 */
export function getViewportSize(page: Page): { width: number; height: number } {
  const viewport = page.viewportSize();
  return viewport || DEFAULT_VIEWPORT;
}

/**
 * Set the viewport size
 */
export async function setViewportSize(
  page: Page,
  width: number,
  height: number
): Promise<void> {
  await page.setViewportSize({ width, height });
}

/**
 * Ensure consistent viewport for AI processing
 */
export async function ensureViewport(
  page: Page,
  viewport: { width: number; height: number } = DEFAULT_VIEWPORT
): Promise<void> {
  const current = page.viewportSize();
  if (!current || current.width !== viewport.width || current.height !== viewport.height) {
    await page.setViewportSize(viewport);
  }
}
