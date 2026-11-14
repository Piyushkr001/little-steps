import Image from "next/image";
import Link from "next/link";
import heroImage from "@/public/Images/hero.png";
import {
    CalendarDays,
    Clock,
    Heart,
    Search,
    ShieldCheck,
    Sprout,
    UserPlus,
    Users,
} from "lucide-react";

import { Button } from "@/components/ui/button";

const TRUST_BADGES = [
    {
        id: 1,
        label: "Verified Caregivers",
        icon: ShieldCheck,
        iconColor: "text-[#087F78]",
    },
    {
        id: 2,
        label: "24×7 Availability",
        icon: Clock,
        iconColor: "text-[#087F78]",
    },
    {
        id: 3,
        label: "Safe & Caring Environment",
        icon: Heart,
        iconColor: "text-[#E58A3B]",
    },
];

const FEATURE_CARDS = [
    {
        id: 1,
        title: "Book Anytime",
        description: "Flexible childcare, 24×7",
        icon: CalendarDays,
        cardBg: "bg-[#F1FAF8] border-[#DCF2EE] dark:bg-card dark:border-border",
        iconBg: "bg-[#DBF2EC] text-[#087F78] dark:bg-[#087F78]/20 dark:text-[#2CC5BC]",
    },
    {
        id: 2,
        title: "Trusted Caregivers",
        description: "Verified, trained, and experienced",
        icon: Users,
        cardBg: "bg-[#FDF6F0] border-[#F8E5D4] dark:bg-card dark:border-border",
        iconBg: "bg-[#FBE6D2] text-[#E58A3B] dark:bg-[#E58A3B]/20 dark:text-[#F2A35E]",
    },
    {
        id: 3,
        title: "Safe & Secure",
        description: "Child-first, always",
        icon: ShieldCheck,
        cardBg: "bg-[#F1FAF8] border-[#DCF2EE] dark:bg-card dark:border-border",
        iconBg: "bg-[#DBF2EC] text-[#087F78] dark:bg-[#087F78]/20 dark:text-[#2CC5BC]",
    },
    {
        id: 4,
        title: "Grow & Learn",
        description: "A nurturing space for every stage",
        icon: Sprout,
        cardBg: "bg-[#FDF6F0] border-[#F8E5D4] dark:bg-card dark:border-border",
        iconBg: "bg-[#FBE6D2] text-[#E58A3B] dark:bg-[#E58A3B]/20 dark:text-[#F2A35E]",
    },
];

export default function Hero() {
    return (
        <section className="relative overflow-hidden bg-[#FAF7F2] dark:bg-background">
            {/* Decorative Corner Blobs */}
            <div
                aria-hidden="true"
                className="pointer-events-none absolute -bottom-10 -left-12 h-36 w-52 rounded-full bg-[#4AA59D]/70 blur-[1px] dark:opacity-20"
            />
            <div
                aria-hidden="true"
                className="pointer-events-none absolute -right-10 -bottom-12 h-32 w-60 rounded-full bg-[#F2B880]/75 blur-[1px] dark:opacity-20"
            />

            <div className="mx-auto max-w-7xl px-4 pt-8 pb-14 sm:px-6 lg:px-8 lg:pt-10 lg:pb-16">
                {/* Main Hero Content */}
                <div className="grid grid-cols-1 items-center gap-10 lg:grid-cols-12 lg:gap-6">
                    {/* Left Column */}
                    <div className="relative z-10 lg:col-span-6">
                        {/* Decorative Orange Rays */}
                        <svg
                            aria-hidden="true"
                            viewBox="0 0 64 52"
                            fill="none"
                            className="-mb-2 -ml-3 h-11 w-14 text-[#ECA05A]"
                        >
                            <path
                                d="M10 38L24 41M15 22L28 30M29 11L36 24M46 8L46 22"
                                stroke="currentColor"
                                strokeWidth="4.5"
                                strokeLinecap="round"
                            />
                        </svg>

                        <h1 className="text-4xl leading-[1.12] font-extrabold tracking-tight text-[#0D3B3E] sm:text-5xl xl:text-[3.45rem] dark:text-foreground">
                            Trusted 24×7
                            <br />
                            <span className="text-[#E58A3B]">Childcare Platform</span>
                        </h1>

                        <p className="mt-5 max-w-xl text-base leading-relaxed text-[#4A5568] sm:text-lg dark:text-muted-foreground">
                            Find and book safe, reliable, and loving childcare anytime,
                            anywhere. Quality care for your little ones, with complete peace
                            of mind.
                        </p>

                        {/* Call to Action Buttons */}
                        <div className="mt-8 flex flex-wrap items-center gap-4">
                            <Button
                                nativeButton={false}
                                render={<Link href="/centers" />}
                                className="h-12 gap-2.5 rounded-full bg-[#087F78] px-7 text-base font-semibold text-white shadow-sm hover:bg-[#066B65]"
                            >
                                <Search className="size-5 stroke-[2.5]" />
                                Find Care
                            </Button>

                            <Button
                                variant="outline"
                                nativeButton={false}
                                render={<Link href="/sign-up" />}
                                className="h-12 gap-2.5 rounded-full border-2 border-[#087F78] bg-white/80 px-7 text-base font-semibold text-[#0D3B3E] hover:bg-[#EAF8F5] hover:text-[#087F78] dark:bg-transparent dark:text-foreground"
                            >
                                <UserPlus className="size-5 text-[#087F78]" />
                                Get Started
                            </Button>
                        </div>

                        {/* Trust Highlights */}
                        <div className="mt-9 flex flex-wrap items-center gap-y-3">
                            {TRUST_BADGES.map((badge, index) => {
                                const Icon = badge.icon;
                                const isLast = index === TRUST_BADGES.length - 1;
                                return (
                                    <div
                                        key={badge.id}
                                        className={`flex items-center gap-2.5 ${
                                            !isLast
                                                ? "mr-5 border-r border-slate-300/90 pr-5 dark:border-border"
                                                : ""
                                        }`}
                                    >
                                        <Icon
                                            className={`size-5 shrink-0 stroke-[2.2] ${badge.iconColor}`}
                                        />
                                        <span className="max-w-32.5 text-xs leading-tight font-semibold text-[#1F3B3E] sm:max-w-none sm:text-sm dark:text-foreground">
                                            {badge.label}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>

                    {/* Right Column - Hero Artwork */}
                    <div className="relative flex items-center justify-center lg:col-span-6 lg:justify-end">
                        <Image
                            src={heroImage}
                            alt="Smiling caregiver playing with a happy child using colorful wooden blocks"
                            preload
                            className="h-auto w-full max-w-xl object-contain drop-shadow-xs lg:max-w-none"
                        />
                    </div>
                </div>

                {/* Bottom Feature Cards */}
                <div className="mt-10 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:mt-12 lg:grid-cols-4 lg:gap-5">
                    {FEATURE_CARDS.map((card) => {
                        const Icon = card.icon;
                        return (
                            <div
                                key={card.id}
                                className={`flex items-center gap-4 rounded-2xl border p-4 shadow-xs transition-transform duration-200 hover:-translate-y-0.5 sm:p-5 ${card.cardBg}`}
                            >
                                <div
                                    className={`flex size-13 shrink-0 items-center justify-center rounded-2xl ${card.iconBg}`}
                                >
                                    <Icon className="size-7 stroke-2" />
                                </div>
                                <div>
                                    <h2 className="text-base font-bold text-[#0D3B3E] sm:text-lg dark:text-foreground">
                                        {card.title}
                                    </h2>
                                    <p className="mt-0.5 text-xs leading-snug text-[#4A5568] sm:text-sm dark:text-muted-foreground">
                                        {card.description}
                                    </p>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        </section>
    );
}
