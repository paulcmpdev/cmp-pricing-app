export default function AdminLoading() {
  return (
    <div className="min-h-screen flex flex-col bg-neutral-900">
      <header className="bg-neutral-950 px-4 py-3 flex items-center gap-4 shrink-0 border-b border-neutral-800">
        <div className="h-7 w-7 rounded bg-neutral-800 animate-pulse" />
        <div className="flex-1">
          <div className="h-4 w-40 bg-neutral-800 rounded animate-pulse" />
        </div>
      </header>
      <main className="flex-1 px-4 py-5 max-w-6xl mx-auto w-full">
        <div className="space-y-4">
          <div className="h-32 rounded-lg bg-neutral-800/50 animate-pulse" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="h-56 rounded-lg bg-neutral-800/50 animate-pulse" />
            <div className="h-56 rounded-lg bg-neutral-800/50 animate-pulse" />
          </div>
          <div className="h-40 rounded-lg bg-neutral-800/50 animate-pulse" />
        </div>
      </main>
    </div>
  );
}
