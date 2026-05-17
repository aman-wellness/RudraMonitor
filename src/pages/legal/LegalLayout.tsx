// Shared wrapper for /legal/privacy + /legal/terms. Reuses the marketing
// navbar/footer so visitors stay in the same visual context.

import Navbar from '@/components/feature/Navbar';
import Footer from '@/components/feature/Footer';

export default function LegalLayout({
  title, lastUpdated, children,
}: {
  title: string;
  lastUpdated: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen bg-dark-900">
      <Navbar />
      <main className="max-w-3xl mx-auto px-4 py-12 md:py-16">
        <header className="mb-8">
          <h1 className="text-3xl md:text-4xl font-poppins font-bold text-white mb-2">{title}</h1>
          <p className="text-xs text-gray-500 uppercase tracking-wider">Last updated · {lastUpdated}</p>
        </header>
        <article className="space-y-8">{children}</article>
      </main>
      <Footer />
    </div>
  );
}
