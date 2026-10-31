import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from ".";

describe("Button", () => {
  it("keeps its label and shows a spinner while loading", () => {
    const markup = renderToStaticMarkup(<Button loading>Import</Button>);

    expect(markup).toContain("Import");
    expect(markup).toContain("<svg");
    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain("disabled");
  });

  it("renders no spinner at rest", () => {
    const markup = renderToStaticMarkup(<Button>Import</Button>);

    expect(markup).not.toContain("<svg");
    expect(markup).not.toContain("aria-busy");
  });
});
