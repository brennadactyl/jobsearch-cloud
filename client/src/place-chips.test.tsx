/**
 * The chips box's two readings of a comma, tested here because only one of them
 * is reachable through a screen.
 *
 * Everywhere a list is entries, a comma is part of a name. Intake still carries
 * its answers as one joined string and asks for the old reading - but its
 * fields re-split the joined answer on every render, so that reading can't be
 * observed through the setup form. Break it there and nothing fails. This is
 * where it can be seen, and the day someone fixes that round trip it is the
 * only thing holding intake's behaviour.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import PlaceChips from "./components/PlaceChips";

function box(props: { splitOnComma?: boolean } = {}) {
  const onChange = vi.fn();
  render(<PlaceChips id="t" entries={[]} onChange={onChange} placeholder="Add a place" {...props} />);
  return { onChange, input: screen.getByRole("textbox") };
}

const chips = () => [...document.querySelectorAll(".place-chip-text")].map((c) => c.textContent);

describe("a comma in the chips box", () => {
  it("is part of the name by default, because a place can hold one", async () => {
    const { input, onChange } = box();

    await userEvent.type(input, "Vancouver, BC{Enter}");

    expect(onChange).toHaveBeenCalledWith(["Vancouver, BC"]);
  });

  it("ends the entry where the caller asks, for a list still carried as one string", async () => {
    const { input, onChange } = box({ splitOnComma: true });

    await userEvent.type(input, "Vancouver, BC{Enter}");

    // Two entries, and the comma committed the first before Enter arrived.
    expect(onChange.mock.calls.map((c) => c[0])).toEqual([["Vancouver"], ["BC"]]);
  });

  it("splits a pasted list only where the caller asks", async () => {
    const { input, onChange } = box({ splitOnComma: true });

    await userEvent.click(input);
    await userEvent.paste("WA, Portland, OR");
    await userEvent.type(input, "{Enter}");

    // Pasting carries no comma keypress, so this is add() splitting rather
    // than the keydown - the half nothing else reaches.
    expect(onChange).toHaveBeenCalledWith(["WA", "Portland", "OR"]);
  });
});

describe("Enter", () => {
  it("adds the entry without sending the form, either way", async () => {
    const { input, onChange } = box();

    await userEvent.type(input, "Remote (US){Enter}");

    expect(onChange).toHaveBeenCalledWith(["Remote (US)"]);
    expect(chips()).toEqual([]);
  });
});
