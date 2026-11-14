"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
    Sheet,
    SheetContent,
    SheetHeader,
    SheetTitle,
    SheetDescription,
} from "@/components/ui/sheet";

import { SignInIcon } from "@phosphor-icons/react";
import { ModeToggle } from "./ModeToggle";

const NAV_LINKS = [
    { id: 1, title: "Home", href: "/" },
    { id: 2, title: "Find Care", href: "/centers" },
    { id: 3, title: "Services", href: "/services" },
    { id: 4, title: "About Us", href: "/about" },
    { id: 5, title: "Contact", href: "/contact" },
];

export default function Navbar() {
    const pathname = usePathname();
    const [menuOpen, setMenuOpen] = useState(false);

    const isActive = (href: string) =>
        href === "/"
            ? pathname === "/"
            : pathname === href || pathname.startsWith(`${href}/`);

    return (
        <header className="sticky top-0 z-50 w-full border-b border-slate-200/70 bg-white/95 shadow-sm backdrop-blur-xl dark:border-border dark:bg-background/95">
            <div className="mx-auto flex h-20 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">

                {/* Brand Logo */}
                <Link
                    href="/"
                    className="flex shrink-0 items-center"
                    aria-label="Little Steps - Home"
                >
                    <Image
                        src="/Images/logo.svg"
                        alt="Little Steps - Trusted 24×7 Childcare"
                        width={220}
                        height={52}
                        priority
                        className="h-auto w-43.75 object-contain sm:w-51.25 xl:w-55"
                    />
                </Link>

                {/* Desktop Navigation */}
                <nav
                    className="hidden items-center gap-5 lg:flex xl:gap-8"
                    aria-label="Main navigation"
                >
                    {NAV_LINKS.map((link) => (
                        <Link
                            key={link.id}
                            href={link.href}
                            aria-current={isActive(link.href) ? "page" : undefined}
                            className={`relative py-2 text-sm font-medium transition-colors duration-200 ${
                                isActive(link.href)
                                    ? "text-[#087F78]"
                                    : "text-slate-600 hover:text-[#087F78] dark:text-muted-foreground dark:hover:text-[#087F78]"
                            }`}
                        >
                            {link.title}

                            {isActive(link.href) && (
                                <span className="absolute right-0 bottom-0 left-0 h-0.5 rounded-full bg-[#087F78]" />
                            )}
                        </Link>
                    ))}
                </nav>

                {/* Desktop Authentication & Theme Toggle */}
                <div className="hidden shrink-0 items-center gap-3 lg:flex">
                    <ModeToggle />

                    <Button
                        variant="outline"
                        size="default"
                        nativeButton={false}
                        render={<Link href="/login" />}
                        className="rounded-full border-[#087F78] px-5 text-[#087F78] hover:bg-[#EAF8F5] hover:text-[#087F78]"
                    >
                        Log In
                    </Button>

                    <Button
                        size="default"
                        nativeButton={false}
                        render={<Link href="/sign-up" />}
                        className="gap-2 rounded-full bg-[#087F78] px-5 text-white shadow-sm hover:bg-[#066B65]"
                    >
                        Sign Up
                        <SignInIcon className="size-4" />
                    </Button>
                </div>

                {/* Mobile Theme Toggle & Menu Button */}
                <div className="flex shrink-0 items-center gap-2 lg:hidden">
                    <ModeToggle />

                    <Button
                        variant="ghost"
                        size="icon"
                        className="text-[#087F78] hover:bg-[#EAF8F5]"
                        aria-label="Open navigation menu"
                        aria-expanded={menuOpen}
                        aria-controls="mobile-navigation"
                        onClick={() => setMenuOpen(true)}
                    >
                        <Menu className="size-6" />
                    </Button>
                </div>

                {/* Mobile Navigation Sheet */}
                <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
                    <SheetContent
                        side="right"
                        id="mobile-navigation"
                        className="flex w-[85vw] max-w-sm flex-col bg-background p-6 sm:max-w-sm"
                    >
                        <SheetHeader className="space-y-2 px-0 text-left">
                            <SheetTitle className="text-xl font-bold text-[#087F78]">
                                Little Steps
                            </SheetTitle>
                            <SheetDescription>
                                Trusted 24×7 Childcare Platform
                            </SheetDescription>
                        </SheetHeader>

                        {/* Mobile Navigation Links */}
                        <nav
                            className="mt-8 flex flex-col gap-2"
                            aria-label="Mobile navigation"
                        >
                            {NAV_LINKS.map((link) => (
                                <Link
                                    key={link.id}
                                    href={link.href}
                                    onClick={() => setMenuOpen(false)}
                                    aria-current={isActive(link.href) ? "page" : undefined}
                                    className={`rounded-xl px-4 py-3 text-base font-medium transition-colors ${
                                        isActive(link.href)
                                            ? "bg-[#EAF8F5] text-[#087F78]"
                                            : "text-foreground hover:bg-muted hover:text-[#087F78]"
                                    }`}
                                >
                                    {link.title}
                                </Link>
                            ))}
                        </nav>

                        {/* Mobile Authentication Buttons */}
                        <div className="mt-auto flex flex-col gap-3 border-t pt-6">
                            <Button
                                variant="outline"
                                size="lg"
                                nativeButton={false}
                                render={<Link href="/login" onClick={() => setMenuOpen(false)} />}
                                className="w-full rounded-full border-[#087F78] text-[#087F78] hover:bg-[#EAF8F5] hover:text-[#087F78]"
                            >
                                Log In
                            </Button>

                            <Button
                                size="lg"
                                nativeButton={false}
                                render={<Link href="/sign-up" onClick={() => setMenuOpen(false)} />}
                                className="w-full gap-2 rounded-full bg-[#087F78] text-white hover:bg-[#066B65]"
                            >
                                Create Account
                                <SignInIcon className="size-4" />
                            </Button>

                            <p className="mt-3 text-center text-xs text-muted-foreground">
                                Safe care. Happy little steps.
                            </p>
                        </div>
                    </SheetContent>
                </Sheet>
            </div>
        </header>
    );
}
