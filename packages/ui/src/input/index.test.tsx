import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Input } from ".";

describe("Input", () => {
  it("composes prefix and suffix affordances with a field", () => {
    const markup = renderToStaticMarkup(
      <Input.Root>
        <Input.Prefix>https://</Input.Prefix>
        <Input.Field aria-label="Domain" />
        <Input.Suffix>.com</Input.Suffix>
      </Input.Root>,
    );

    expect(markup).toContain('data-slot="prefix"');
    expect(markup).toContain('data-slot="field"');
    expect(markup).toContain('data-slot="suffix"');
  });

  it("marks bare fields so inline editors drop the field chrome", () => {
    const markup = renderToStaticMarkup(
      <>
        <Input.Field appearance="bare" aria-label="Title" />
        <Input.Textarea appearance="bare" aria-label="Note" />
        <Input.Field aria-label="Name" />
      </>,
    );

    expect(markup.match(/data-appearance="bare"/g)).toHaveLength(2);
  });
});
