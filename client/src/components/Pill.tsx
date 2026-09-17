import { pillFor } from "../domain/constants";

/** A lead's or application's status, coloured by what it means. */
export function Pill({ status }: { status: string }) {
  return <span className={`pill ${pillFor(status)}`}>{status}</span>;
}
