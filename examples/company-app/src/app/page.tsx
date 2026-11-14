import { SupportChat } from "@/components/support-chat";

export default function Home() {
  return (
    <main className="app-shell">
      <header className="page-heading">
        <h1>Company support</h1>
        <p>Connected to your independently deployed Auggy agent.</p>
      </header>
      <SupportChat />
    </main>
  );
}
