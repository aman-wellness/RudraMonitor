import { testimonials } from '@/mocks/testimonials';

export default function TestimonialsSection() {
  const renderStars = (rating: number) => {
    return Array.from({ length: 5 }).map((_, i) => (
      <span key={i} className="w-4 h-4 flex items-center justify-center">
        {i < rating ? (
          <i className="ri-star-fill text-emerald-400 text-sm" />
        ) : (
          <i className="ri-star-line text-emerald-400 text-sm" />
        )}
      </span>
    ));
  };

  return (
    <section id="testimonials" className="relative bg-dark-800 py-16 md:py-24">
      <div className="w-full px-4 md:px-8 lg:px-12">
        {/* Trust Badge Strip */}
        <div className="bg-dark-900 border border-dark-700 rounded-lg p-6 md:p-8 text-center mb-12 md:mb-16">
          <p className="text-lg md:text-xl font-poppins font-semibold text-white mb-4">
            Trusted by 500+ Companies Across India
          </p>
          <div className="flex items-center justify-center gap-6 md:gap-10 flex-wrap opacity-50 grayscale">
            {['TechSolutions', 'InnovateSoft', 'DataWave', 'CloudMax', 'ByteForge', 'NextGenIT'].map((company) => (
              <span key={company} className="text-sm md:text-base font-medium text-gray-400 whitespace-nowrap">
                {company}
              </span>
            ))}
          </div>
        </div>

        {/* Section Header */}
        <div className="text-center mb-10 md:mb-14">
          <div className="inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/20 rounded-full px-4 py-2 mb-4">
            <i className="ri-chat-smile-3-line text-emerald-400 text-sm" />
            <span className="text-xs md:text-sm text-emerald-400 font-medium">
              Client Reviews
            </span>
          </div>
          <h2 className="text-2xl md:text-3xl lg:text-4xl font-poppins font-bold text-white mb-4">
            What Our Clients Say
          </h2>
          <p className="text-sm md:text-base text-gray-400 max-w-2xl mx-auto">
            See why businesses trust Rudrans for their employee monitoring needs
          </p>
        </div>

        {/* Testimonials Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-5">
          {testimonials.map((t, idx) => (
            <div
              key={t.id}
              className={`bg-dark-900 border border-dark-700 rounded-lg p-5 md:p-6 hover:border-emerald-500/20 transition-all duration-300 ${
                idx === 0 ? 'md:row-span-2' : ''
              }`}
            >
              {/* Stars */}
              <div className="flex items-center gap-0.5 mb-4">
                {renderStars(t.rating)}
              </div>

              {/* Quote */}
              <p className="text-sm md:text-base text-gray-300 leading-relaxed mb-5">
                &ldquo;{t.text}&rdquo;
              </p>

              {/* User */}
              <div className="flex items-center gap-3">
                <img
                  src={t.avatar}
                  alt={t.name}
                  className="w-10 h-10 rounded-full object-cover"
                />
                <div>
                  <p className="text-sm font-medium text-white">{t.name}</p>
                  <p className="text-xs text-gray-500">
                    {t.position}, {t.company}
                  </p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}