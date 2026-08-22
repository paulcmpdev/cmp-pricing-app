import { vi } from "vitest";

// Global mock for server-only so all pricing modules can be tested in Vitest
vi.mock("server-only", () => ({}));
