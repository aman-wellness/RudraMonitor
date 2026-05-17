import Navbar from '@/components/feature/Navbar';
import HeroSection from './components/HeroSection';
import FeaturesGrid from './components/FeaturesGrid';
import FeatureShowcase from './components/FeatureShowcase';
import SystemHealthSection from './components/SystemHealthSection';
import EmployeeManagementSection from './components/EmployeeManagementSection';
import PricingSection from './components/PricingSection';
import TestimonialsSection from './components/TestimonialsSection';
import CTASection from './components/CTASection';
import Footer from '@/components/feature/Footer';

export default function Home() {
  return (
    <div className="min-h-screen bg-dark-900">
      <Navbar />
      <HeroSection />
      <FeaturesGrid />
      <FeatureShowcase />
      <SystemHealthSection />
      <EmployeeManagementSection />
      <PricingSection />
      <TestimonialsSection />
      <CTASection />
      <Footer />
    </div>
  );
}