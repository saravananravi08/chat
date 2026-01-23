import { HomePage } from "./pages/HomePage";
import { SettingsPage } from "./pages/SettingsPage";

export function App({ pathname }: { pathname: string }) {
  switch (pathname) {
    case "/settings":
      return <SettingsPage />;
    case "/":
    default:
      return <HomePage />;
  }
}
