import { useState } from 'react';

export default function Footer() {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (email) {
      setSubmitted(true);
      setEmail('');
      setTimeout(() => setSubmitted(false), 3000);
    }
  };

  return (
    <footer id="contact" className="relative bg-dark-800 border-t border-dark-700">
      <div className="w-full px-4 md:px-8 lg:px-12 py-12 md:py-16">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-8 md:gap-10">
          {/* Brand Column */}
          <div className="sm:col-span-2 lg:col-span-1">
            <div className="flex items-center gap-3 mb-4">
              <img
                src="https://public.readdy.ai/ai/img_res/30434500-ce14-4d0b-944f-490cb4702e27.png"
                alt="Rudrans Logo"
                className="h-8 w-8 object-contain"
              />
              <span className="text-white font-poppins font-bold text-lg">
                Rudrans
              </span>
            </div>
            <p className="text-sm text-gray-500 mb-5 leading-relaxed">
              Enterprise-grade employee monitoring solution for Windows, macOS & Ubuntu.
              Real-time insights, AI-powered reports, and complete visibility.
            </p>
            <div className="flex items-center gap-3">
              {[
                { icon: 'ri-linkedin-fill', label: 'LinkedIn' },
                { icon: 'ri-twitter-x-fill', label: 'Twitter' },
                { icon: 'ri-facebook-fill', label: 'Facebook' },
                { icon: 'ri-instagram-line', label: 'Instagram' },
              ].map((social) => (
                <a
                  key={social.label}
                  href="#"
                  aria-label={social.label}
                  className="w-9 h-9 flex items-center justify-center bg-dark-700 hover:bg-emerald-500/20 rounded-lg text-gray-400 hover:text-emerald-400 transition-all duration-200"
                >
                  <i className={`${social.icon} text-sm`} />
                </a>
              ))}
            </div>
          </div>

          {/* Product Column */}
          <div>
            <h4 className="text-sm font-semibold text-white mb-4">
              Product
            </h4>
            <ul className="space-y-2.5">
              {['Features', 'Pricing', 'Integrations', 'Security', 'API'].map((item) => (
                <li key={item}>
                  <a
                    href="#"
                    className="text-sm text-gray-500 hover:text-emerald-400 transition-colors duration-200"
                  >
                    {item}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Resources Column */}
          <div>
            <h4 className="text-sm font-semibold text-white mb-4">
              Resources
            </h4>
            <ul className="space-y-2.5">
              {['Documentation', 'Blog', 'Case Studies', 'Support', 'FAQs'].map((item) => (
                <li key={item}>
                  <a
                    href="#"
                    className="text-sm text-gray-500 hover:text-emerald-400 transition-colors duration-200"
                  >
                    {item}
                  </a>
                </li>
              ))}
            </ul>
          </div>

          {/* Contact Column */}
          <div>
            <h4 className="text-sm font-semibold text-white mb-4">
              Contact
            </h4>
            <form onSubmit={handleSubmit} className="mb-4">
              <div className="flex gap-2">
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="Enter your email"
                  className="flex-1 bg-dark-900 border border-dark-700 rounded-md px-3 py-2 text-sm text-white placeholder-gray-600 focus:outline-none focus:border-emerald-500 transition-colors"
                />
                <button
                  type="submit"
                  className="bg-emerald-500 hover:bg-emerald-600 text-white px-4 py-2 rounded-md text-sm font-medium transition-all whitespace-nowrap"
                >
                  {submitted ? 'Done!' : 'Subscribe'}
                </button>
              </div>
            </form>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="w-4 h-4 flex items-center justify-center">
                  <i className="ri-mail-line text-gray-500 text-xs" />
                </span>
                <span className="text-sm text-gray-500">support@rudrans.com</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-4 h-4 flex items-center justify-center">
                  <i className="ri-phone-line text-gray-500 text-xs" />
                </span>
                <span className="text-sm text-gray-500">+91 98765 43210</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom Bar */}
      <div className="bg-dark-900 border-t border-dark-700">
        <div className="w-full px-4 md:px-8 lg:px-12 py-4">
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
            <p className="text-xs text-gray-600">
              &copy; 2025 Rudrans. All rights reserved.
            </p>
            <div className="flex items-center gap-4">
              {['Privacy Policy', 'Terms of Service', 'Cookie Policy'].map((item) => (
                <a
                  key={item}
                  href="#"
                  className="text-xs text-gray-600 hover:text-gray-400 transition-colors"
                >
                  {item}
                </a>
              ))}
            </div>
          </div>
        </div>
      </div>
    </footer>
  );
}