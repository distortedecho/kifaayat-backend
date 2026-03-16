import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";

// Mock Clerk middleware — always sets a user ID
vi.mock("../middleware/clerk.js", () => ({
  clerkMiddleware: vi.fn(async (c: any, next: any) => {
    c.set("clerkUserId", "test-clerk-user-123");
    await next();
  }),
  optionalClerkMiddleware: vi.fn(async (c: any, next: any) => {
    await next();
  }),
}));

// Mock @google/genai
const mockGenerateContent = vi.fn();
vi.mock("@google/genai", () => {
  return {
    GoogleGenAI: class MockGoogleGenAI {
      constructor(_config: { apiKey: string }) {}
      models = {
        generateContent: mockGenerateContent,
      };
    },
  };
});

// Mock background removal
const mockRemoveBackground = vi.fn();
vi.mock("../lib/background-removal.js", () => ({
  removeBackground: (...args: any[]) => mockRemoveBackground(...args),
}));

// Set env var before importing routes
process.env.GEMINI_API_KEY = "test-gemini-key";

// Import after mocks
const { default: aiRoutes } = await import("../routes/ai.js");

function createApp() {
  const app = new Hono();
  app.route("/api/ai", aiRoutes);
  return app;
}

// A minimal 1x1 white JPEG in base64 (valid image)
const TINY_BASE64_PHOTO =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYI4Q/SFhSRTcoKi4oKy0tLS4vKysrLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL//aAAwDAQACEQMRAD8AX//Z";

describe("POST /api/ai/analyze", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with analysis when given valid photos", async () => {
    const mockResponse = {
      category: "Lehenga",
      category_confidence: 95,
      title: "Beautiful Red Lehenga",
      title_confidence: 88,
      description: "A stunning red lehenga with gold embroidery",
      description_confidence: 82,
      suggested_price: 15000,
      suggested_price_confidence: 70,
      condition: "Like New",
      condition_confidence: 90,
      colors: ["red", "gold"],
      colors_confidence: 95,
      occasion_tags: ["Wedding", "Sangeet"],
      occasion_tags_confidence: 85,
    };

    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(mockResponse),
    });

    const app = createApp();
    const res = await app.request("/api/ai/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photos: [TINY_BASE64_PHOTO] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();

    // Verify structured response with confidence scores
    expect(body.category).toBeDefined();
    expect(body.category.value).toBe("Lehenga");
    expect(body.category.confidence).toBeGreaterThanOrEqual(0);
    expect(body.category.confidence).toBeLessThanOrEqual(100);

    expect(body.title).toBeDefined();
    expect(body.title.value).toBe("Beautiful Red Lehenga");

    expect(body.description).toBeDefined();
    expect(body.suggested_price).toBeDefined();
    expect(body.condition).toBeDefined();
    expect(body.colors).toBeDefined();
    expect(body.occasion_tags).toBeDefined();
  });

  it("returns 400 when no photos provided", async () => {
    const app = createApp();
    const res = await app.request("/api/ai/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photos: [] }),
    });

    expect(res.status).toBe(400);
  });

  it("returns 400 when photos field is missing", async () => {
    const app = createApp();
    const res = await app.request("/api/ai/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("returns 503 with fallback error when Gemini API fails twice", async () => {
    mockGenerateContent.mockRejectedValue(new Error("Gemini API error"));

    const app = createApp();
    const res = await app.request("/api/ai/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photos: [TINY_BASE64_PHOTO] }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.fallback).toBe(true);

    // Verify retry happened (called twice)
    expect(mockGenerateContent).toHaveBeenCalledTimes(2);
  });

  it("sets confidence to 0 for invalid category values", async () => {
    const mockResponse = {
      category: "InvalidCategory",
      category_confidence: 95,
      title: "Test Item",
      title_confidence: 88,
      description: "Test description",
      description_confidence: 82,
      suggested_price: 15000,
      suggested_price_confidence: 70,
      condition: "Like New",
      condition_confidence: 90,
      colors: ["red"],
      colors_confidence: 95,
      occasion_tags: ["Wedding"],
      occasion_tags_confidence: 85,
    };

    mockGenerateContent.mockResolvedValue({
      text: JSON.stringify(mockResponse),
    });

    const app = createApp();
    const res = await app.request("/api/ai/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photos: [TINY_BASE64_PHOTO] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.category.confidence).toBe(0);
  });
});

describe("POST /api/ai/remove-background", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with processed image when given valid photo", async () => {
    mockRemoveBackground.mockResolvedValue("processed-base64-result");

    const app = createApp();
    const res = await app.request("/api/ai/remove-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo: TINY_BASE64_PHOTO }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed_photo).toBe("processed-base64-result");
    expect(body.original_photo).toBe(TINY_BASE64_PHOTO);
  });

  it("returns 400 when no photo provided", async () => {
    const app = createApp();
    const res = await app.request("/api/ai/remove-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
  });

  it("returns 503 with fallback error when background removal fails", async () => {
    mockRemoveBackground.mockRejectedValue(new Error("Processing failed"));

    const app = createApp();
    const res = await app.request("/api/ai/remove-background", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photo: TINY_BASE64_PHOTO }),
    });

    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBeDefined();
    expect(body.fallback).toBe(true);
  });
});
