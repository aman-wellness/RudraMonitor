import { Link } from "react-router-dom";

export default function NotFound() {
  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen text-center px-4 bg-dark-900">
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[12rem] md:text-[16rem] font-black text-dark-800 select-none pointer-events-none z-0">
        404
      </div>
      <div className="relative z-10">
        <span className="w-16 h-16 flex items-center justify-center bg-emerald-500/20 rounded-full mx-auto mb-6">
          <i className="ri-alert-line text-emerald-400 text-2xl" />
        </span>
        <h1 className="text-2xl md:text-3xl font-poppins font-bold text-white mb-3">
          Page Not Found
        </h1>
        <p className="text-base text-gray-400 mb-8 max-w-md mx-auto">
          The page you are looking for does not exist or has been moved.
        </p>
        <Link
          to="/"
          className="inline-flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 text-white px-6 py-3 rounded-lg font-medium transition-all duration-200 whitespace-nowrap"
        >
          <span className="w-5 h-5 flex items-center justify-center">
            <i className="ri-home-line" />
          </span>
          Go Back Home
        </Link>
      </div>
    </div>
  );
}