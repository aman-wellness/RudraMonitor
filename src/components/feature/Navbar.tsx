import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setScrolled(window.scrollY > 50);
    };
    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const navLinks = [
    { label: 'Features', href: '#features' },
    { label: 'Employee Mgmt', href: '#employee-management' },
    { label: 'Pricing', href: '#pricing' },
    { label: 'Testimonials', href: '#testimonials' },
    { label: 'Contact', href: '#contact' },
  ];

  return (
    <nav
      className={`fixed top-0 left-0 right-0 z-50 transition-all duration-300 ${
        scrolled
          ? 'bg-dark-900/95 backdrop-blur-md shadow-lg'
          : 'bg-transparent'
      }`}
    >
      <div className="w-full px-4 md:px-8 lg:px-12">
        <div className="flex items-center justify-between h-16 md:h-20">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-3">
            <img
              src="https://public.readdy.ai/ai/img_res/30434500-ce14-4d0b-944f-490cb4702e27.png"
              alt="Rudrans Logo"
              className="h-8 w-8 md:h-10 md:w-10 object-contain"
            />
            <span className="text-white font-poppins font-bold text-lg md:text-xl tracking-wide">
              Rudrans
            </span>
          </Link>

          {/* Desktop Nav */}
          <div className="hidden md:flex items-center gap-8">
            {navLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                className="text-sm text-gray-400 hover:text-emerald-400 transition-colors duration-200 font-medium"
              >
                {link.label}
              </a>
            ))}
          </div>

          {/* Desktop Buttons */}
          <div className="hidden md:flex items-center gap-3">
            <Link
              to="/partner/login"
              className="text-sm text-violet-400 hover:text-violet-300 px-3 py-2 rounded-md transition-all duration-200 whitespace-nowrap"
            >
              Partner Login
            </Link>
            <Link
              to="/login"
              className="text-sm text-white border border-dark-600 hover:border-emerald-500 hover:text-emerald-400 px-5 py-2 rounded-md transition-all duration-200 whitespace-nowrap"
            >
              Login
            </Link>
            <Link
              to="/signup"
              className="text-sm bg-emerald-500 hover:bg-emerald-600 text-white px-5 py-2 rounded-md transition-all duration-200 whitespace-nowrap"
            >
              Start Free Trial
            </Link>
          </div>

          {/* Mobile Menu Button */}
          <button
            className="md:hidden w-10 h-10 flex items-center justify-center text-white"
            onClick={() => setMobileOpen(!mobileOpen)}
            aria-label="Toggle menu"
          >
            <i className={`ri-${mobileOpen ? 'close' : 'menu'}-line text-xl`} />
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      {mobileOpen && (
        <div className="md:hidden bg-dark-900/98 backdrop-blur-md border-t border-dark-700">
          <div className="px-4 py-4 space-y-3">
            {navLinks.map((link) => (
              <a
                key={link.label}
                href={link.href}
                onClick={() => setMobileOpen(false)}
                className="block text-sm text-gray-400 hover:text-emerald-400 py-2 transition-colors"
              >
                {link.label}
              </a>
            ))}
            <div className="pt-3 border-t border-dark-700 space-y-2">
              <Link
                to="/partner/login"
                className="block text-center text-sm text-violet-400 border border-violet-500/30 py-2 rounded-md"
              >
                Partner Login
              </Link>
              <Link
                to="/login"
                className="block text-center text-sm text-white border border-dark-600 py-2 rounded-md"
              >
                Login
              </Link>
              <Link
                to="/signup"
                className="block text-center text-sm bg-emerald-500 text-white py-2 rounded-md"
              >
                Start Free Trial
              </Link>
            </div>
          </div>
        </div>
      )}
    </nav>
  );
}