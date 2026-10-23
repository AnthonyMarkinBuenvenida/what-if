import { DemoProvider } from "./DemoContext";

/** Shares one demo session between the guided demo and Presentation Mode. */
export default function DemoLayout() {
  return <DemoProvider />;
}
