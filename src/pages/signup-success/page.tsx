import { Link, useSearchParams } from 'react-router-dom';

export default function SignupSuccess() {
  const [params] = useSearchParams();
  const email = params.get('email') ?? 'your email';

  return (
    <div className="min-h-screen relative overflow-hidden flex items-center justify-center px-4 py-8 login-bg login-bg-emerald">
      <div className="aurora aurora-a" aria-hidden />
      <div className="aurora aurora-b" aria-hidden />
      <div className="aurora aurora-c" aria-hidden />
      <div className="absolute inset-0 grid-overlay pointer-events-none" aria-hidden />

      <div className="relative z-10 w-full max-w-md">
        <div className="bg-dark-900/80 backdrop-blur border border-dark-700 rounded-2xl p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-emerald-500/15 border border-emerald-500/40 mx-auto mb-5 flex items-center justify-center">
            <i className="ri-mail-check-line text-3xl text-emerald-400" />
          </div>

          <h1 className="text-2xl font-semibold text-white mb-2">Payment verified — check your inbox</h1>
          <p className="text-sm text-gray-400 leading-relaxed mb-5">
            Your card has been verified successfully. We just sent a secure invite to{' '}
            <span className="text-white font-medium break-all">{email}</span>.
          </p>

          <div className="text-left text-xs space-y-2 mb-6 bg-dark-800/60 border border-dark-700 rounded-lg p-4">
            <p className="font-medium text-gray-300 flex items-center gap-1.5">
              <i className="ri-arrow-right-circle-line text-emerald-400" />
              Open the email titled <span className="text-white">&quot;Welcome to Rudrans&quot;</span>
            </p>
            <p className="font-medium text-gray-300 flex items-center gap-1.5">
              <i className="ri-arrow-right-circle-line text-emerald-400" />
              Click the invite button to set your password
            </p>
            <p className="font-medium text-gray-300 flex items-center gap-1.5">
              <i className="ri-arrow-right-circle-line text-emerald-400" />
              You land in your dashboard with a 14-day trial active
            </p>
          </div>

          <p className="text-[11px] text-gray-500 mb-5 leading-relaxed">
            <strong>Don&apos;t see it?</strong> Check spam, or wait a minute — emails sometimes take 30-60 seconds to arrive.
            Still nothing? Contact{' '}
            <a href="mailto:itsupport@wellnessextract.com" className="text-emerald-400 hover:text-emerald-300">itsupport@wellnessextract.com</a>.
          </p>

          <Link
            to="/login"
            className="inline-block w-full bg-emerald-500 hover:bg-emerald-400 text-dark-950 font-medium py-3 rounded-lg transition-colors"
          >
            Go to Login
          </Link>
        </div>
      </div>
    </div>
  );
}
