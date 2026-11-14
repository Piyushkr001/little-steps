
import Image from "next/image";
import Link from "next/link";
import {
  ArrowRight,
  ArrowUpRight,
  Baby,
  Heart,
  Mail,
  MapPin,
  ShieldCheck,
  Clock3,
} from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";

const QUICK_LINKS = [
  { title: "Home", href: "/" },
  { title: "About Us", href: "/about" },
  { title: "Our Services", href: "/services" },
  { title: "Find Care", href: "/centers" },
  { title: "Contact Us", href: "/contact" },
];

const PARENT_LINKS = [
  { title: "Find Childcare", href: "/centers" },
  { title: "How It Works", href: "/how-it-works" },
  { title: "Safety & Trust", href: "/safety" },
  { title: "Create Account", href: "/sign-up" },
];

const PROVIDER_LINKS = [
  { title: "Become a Provider", href: "/providers/register" },
  { title: "Provider Login", href: "/login" },
  { title: "Help & Support", href: "/contact" },
];

const LEGAL_LINKS = [
  { title: "Privacy Policy", href: "/privacy" },
  { title: "Terms of Service", href: "/terms" },
  { title: "Safety Policy", href: "/safety" },
];

function FooterLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group flex w-fit items-center gap-1.5 text-sm text-slate-600 transition-colors duration-200 hover:text-[#087F78] dark:text-slate-400 dark:hover:text-[#6DD6C9]"
    >
      <span>{children}</span>
      <ArrowUpRight
        size={13}
        className="opacity-0 transition-all duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5 group-hover:opacity-100"
        aria-hidden="true"
      />
    </Link>
  );
}

export default function Footer() {
  const currentYear = new Date().getFullYear();

  return (
    <footer className="w-full bg-[#F7FBFA] text-slate-800 dark:bg-[#071F20] dark:text-slate-100">

      {/* Call to Action */}
      <div className="px-4 pt-12 sm:px-6 lg:px-8">
        <div className="relative mx-auto flex max-w-7xl flex-col items-center justify-between gap-8 overflow-hidden rounded-3xl bg-[#087F78] px-6 py-10 text-white shadow-lg sm:px-10 sm:py-12 lg:flex-row lg:px-14">

          {/* Decorative circles */}
          <div className="pointer-events-none absolute -right-12 -top-20 h-56 w-56 rounded-full bg-white/10" />
          <div className="pointer-events-none absolute -bottom-24 right-1/3 h-48 w-48 rounded-full bg-[#F2A65A]/15" />

          <div className="relative z-10 max-w-2xl space-y-4 text-center lg:text-left">
            <div className="inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-xs font-semibold text-white">
              <Heart size={15} className="fill-[#F2A65A] text-[#F2A65A]" />
              Every little step matters
            </div>

            <h2 className="text-2xl font-extrabold leading-tight tracking-tight sm:text-3xl lg:text-4xl">
              Find the right care for your little one.
            </h2>

            <p className="max-w-xl text-sm leading-7 text-white/85 sm:text-base">
              Explore childcare options, compare services, and
              find care that fits your family's schedule.
            </p>
          </div>

          <div className="relative z-10 flex w-full shrink-0 flex-col gap-3 sm:w-auto sm:flex-row">
            <Link
              href="/centers"
              className={buttonVariants({
                size: "lg",
                className:
                  "h-12 gap-2 rounded-full bg-white px-6 font-semibold text-[#087F78] shadow-sm hover:bg-[#EAF8F5] hover:text-[#066B65]",
              })}
            >
              Find Childcare
              <ArrowRight size={17} />
            </Link>

            <Link
              href="/providers/register"
              className={buttonVariants({
                variant: "outline",
                size: "lg",
                className:
                  "h-12 rounded-full border-white/70 bg-transparent px-6 font-semibold text-white hover:bg-white/15 hover:text-white",
              })}
            >
              Join as Provider
            </Link>
          </div>
        </div>
      </div>

      {/* Main Footer */}
      <div className="mx-auto max-w-7xl px-4 pb-10 pt-14 sm:px-6 lg:px-8 lg:pt-20">
        <div className="flex flex-col gap-12 lg:flex-row lg:justify-between lg:gap-10">

          {/* Brand and Description */}
          <div className="flex w-full flex-col gap-5 lg:max-w-85">
            <Link
              href="/"
              className="inline-flex w-fit items-center"
              aria-label="Little Steps Home"
            >
              <Image
                src="/Images/logo.svg"
                alt="Little Steps - Trusted 24×7 Childcare"
                width={240}
                height={57}
                className="h-auto w-50 object-contain sm:w-56.25"
              />
            </Link>

            <p className="max-w-sm text-sm leading-7 text-slate-600 dark:text-slate-400">
              Little Steps is a childcare discovery and booking
              platform designed to help families explore daycare
              centres, connect with childcare providers, and find
              flexible care options.
            </p>

            {/* Highlights */}
            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#E1F4F0] px-3 py-1.5 text-xs font-medium text-[#087F78] dark:bg-teal-950 dark:text-teal-300">
                <ShieldCheck size={14} />
                Trust & Safety
              </span>

              <span className="inline-flex items-center gap-1.5 rounded-full bg-[#FFF0DF] px-3 py-1.5 text-xs font-medium text-[#A65B16] dark:bg-orange-950 dark:text-orange-300">
                <Clock3 size={14} />
                Flexible Care
              </span>
            </div>
          </div>

          {/* Navigation Columns */}
          <div className="flex flex-1 flex-wrap justify-between gap-x-8 gap-y-10 lg:justify-end lg:gap-x-12 xl:gap-x-16">

            {/* Quick Links */}
            <div className="flex min-w-30 flex-col gap-5">
              <h3 className="text-sm font-bold tracking-wide text-[#075E58] dark:text-teal-300">
                Quick Links
              </h3>

              <nav aria-label="Footer quick links" className="flex flex-col gap-3.5">
                {QUICK_LINKS.map((link) => (
                  <FooterLink key={link.href} href={link.href}>
                    {link.title}
                  </FooterLink>
                ))}
              </nav>
            </div>

            {/* For Parents */}
            <div className="flex min-w-33.75 flex-col gap-5">
              <h3 className="text-sm font-bold tracking-wide text-[#075E58] dark:text-teal-300">
                For Parents
              </h3>

              <nav aria-label="Parent resources" className="flex flex-col gap-3.5">
                {PARENT_LINKS.map((link) => (
                  <FooterLink key={link.href} href={link.href}>
                    {link.title}
                  </FooterLink>
                ))}
              </nav>
            </div>

            {/* For Providers */}
            <div className="flex min-w-36.25 flex-col gap-5">
              <h3 className="text-sm font-bold tracking-wide text-[#075E58] dark:text-teal-300">
                For Providers
              </h3>

              <nav aria-label="Provider resources" className="flex flex-col gap-3.5">
                {PROVIDER_LINKS.map((link) => (
                  <FooterLink key={link.href} href={link.href}>
                    {link.title}
                  </FooterLink>
                ))}
              </nav>

              {/* Contact */}
              <div className="mt-2 flex flex-col gap-3">
                <h4 className="text-sm font-bold text-[#075E58] dark:text-teal-300">
                  Need Assistance?
                </h4>

                <Link
                  href="/contact"
                  className="flex items-center gap-2 text-sm text-slate-600 transition-colors hover:text-[#087F78] dark:text-slate-400 dark:hover:text-teal-300"
                >
                  <Mail size={16} className="shrink-0 text-[#087F78]" />
                  Contact Support
                </Link>

                <Link
                  href="/centers"
                  className="flex items-center gap-2 text-sm text-slate-600 transition-colors hover:text-[#087F78] dark:text-slate-400 dark:hover:text-teal-300"
                >
                  <MapPin size={16} className="shrink-0 text-[#087F78]" />
                  Explore Locations
                </Link>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Separator */}
        <Separator className="my-10 bg-[#087F78]/15 dark:bg-white/15" />

        {/* Bottom Footer */}
        <div className="flex flex-col items-center justify-between gap-5 text-center sm:flex-row sm:text-left">
          <p className="text-xs leading-6 text-slate-500 dark:text-slate-400 sm:text-sm">
            © {currentYear} Little Steps. All rights reserved.
          </p>

          <nav
            className="flex flex-wrap items-center justify-center gap-x-5 gap-y-3"
            aria-label="Legal and policy links"
          >
            {LEGAL_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-xs text-slate-500 transition-colors hover:text-[#087F78] dark:text-slate-400 dark:hover:text-teal-300 sm:text-sm"
              >
                {link.title}
              </Link>
            ))}
          </nav>
        </div>

        {/* Footer Note */}
        <div className="mt-8 flex items-center justify-center gap-2 text-center text-xs text-slate-500 dark:text-slate-400">
          <Baby size={15} className="text-[#F2A65A]" />
          <span>Made with care for little ones and their families.</span>
          <Heart
            size={14}
            className="fill-[#F2A65A] text-[#F2A65A]"
          />
        </div>
      </div>
    </footer>
  );
}
