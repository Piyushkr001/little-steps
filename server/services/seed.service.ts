import { eq, sql } from "drizzle-orm";
import { db } from "@/config/db";
import {
  adminAuditLogs,
  adminProfiles,
  bookings,
  bookingStatusHistory,
  capacityRules,
  caregivers,
  centers,
  children,
  disputes,
  incidentActivity,
  notifications,
  platformSettings,
  providers,
  providerVerifications,
  safetyIncidents,
  userRoles,
  users,
  verificationDocuments,
} from "@/config/schema";
import { computeAuditIntegrityHash } from "../security/crypto";

let isSeededInProcess = false;

export async function ensureAdminPortalSeeded(): Promise<void> {
  if (isSeededInProcess) return;

  try {
    const existingAdmin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@littlesteps.com"))
      .limit(1);

    if (existingAdmin.length > 0) {
      isSeededInProcess = true;
      return;
    }

    const now = new Date();
    const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
    const hoursFromNow = (h: number) => new Date(now.getTime() + h * 3_600_000);

    // 1. Insert Authorized Administrators & Representative Users
    const insertedUsers = await db
      .insert(users)
      .values([
        {
          email: "superadmin@littlesteps.com",
          name: "Aarav Mehta",
          phone: "+1 (555) 201-0001",
          role: "SUPER_ADMIN",
          status: "ACTIVE",
          emailVerified: true,
          lastLoginAt: daysAgo(1),
          createdAt: daysAgo(150),
        },
        {
          email: "admin@littlesteps.com",
          name: "Priya Sharma",
          phone: "+1 (555) 201-0002",
          role: "ADMIN",
          status: "ACTIVE",
          emailVerified: true,
          lastLoginAt: daysAgo(2),
          createdAt: daysAgo(120),
        },
        {
          email: "littlesteps.admin@gmail.com",
          name: "Rohan Verma",
          phone: "+1 (555) 201-0003",
          role: "ADMIN",
          status: "ACTIVE",
          emailVerified: true,
          lastLoginAt: daysAgo(3),
          createdAt: daysAgo(90),
        },
        {
          email: "suspended.admin@littlesteps.com",
          name: "Suspended Administrator",
          phone: "+1 (555) 201-0099",
          role: "ADMIN",
          status: "SUSPENDED",
          emailVerified: true,
          suspendedReason: "Security policy review pending",
          suspendedAt: daysAgo(10),
          createdAt: daysAgo(85),
        },
        {
          email: "parent.admin@example.com",
          name: "Neha Kapoor (Parent with admin keyword)",
          phone: "+1 (555) 310-1001",
          role: "PARENT",
          status: "ACTIVE",
          emailVerified: true,
          createdAt: daysAgo(75),
        },
        {
          email: "ananya.patel@example.com",
          name: "Ananya Patel",
          phone: "+1 (555) 310-1002",
          role: "PARENT",
          status: "ACTIVE",
          emailVerified: true,
          createdAt: daysAgo(60),
        },
        {
          email: "david.chen@example.com",
          name: "David Chen",
          phone: "+1 (555) 310-1003",
          role: "PARENT",
          status: "ACTIVE",
          emailVerified: true,
          createdAt: daysAgo(45),
        },
        {
          email: "sarah.jenkins@example.com",
          name: "Sarah Jenkins",
          phone: "+1 (555) 310-1004",
          role: "PARENT",
          status: "ACTIVE",
          emailVerified: true,
          createdAt: daysAgo(20),
        },
        {
          email: "director@sunshinekids.org",
          name: "Kavita Nair",
          phone: "+1 (555) 410-2001",
          role: "PROVIDER",
          status: "ACTIVE",
          emailVerified: true,
          createdAt: daysAgo(110),
        },
        {
          email: "founder@littleexplorers.io",
          name: "Marcus Vance",
          phone: "+1 (555) 410-2002",
          role: "PROVIDER",
          status: "ACTIVE",
          emailVerified: true,
          createdAt: daysAgo(50),
        },
        {
          email: "contact@brightbeginnings.care",
          name: "Elena Rostova",
          phone: "+1 (555) 410-2003",
          role: "PROVIDER",
          status: "ACTIVE",
          emailVerified: true,
          createdAt: daysAgo(15),
        },
        {
          email: "care@harmonychildcare.org",
          name: "Dr. Vikram Sethi",
          phone: "+1 (555) 410-2004",
          role: "PROVIDER",
          status: "ACTIVE",
          emailVerified: true,
          createdAt: daysAgo(8),
        },
      ])
      .returning();

    const byEmail = Object.fromEntries(insertedUsers.map((u) => [u.email, u]));
    const superAdmin = byEmail["superadmin@littlesteps.com"];
    const mainAdmin = byEmail["admin@littlesteps.com"];
    const gmailAdmin = byEmail["littlesteps.admin@gmail.com"];
    const suspendedAdmin = byEmail["suspended.admin@littlesteps.com"];

    // 2. Insert user_roles
    await db.insert(userRoles).values(
      insertedUsers.map((u) => ({
        userId: u.id,
        role: u.role,
        assignedBy: superAdmin.id,
        isActive: u.status === "ACTIVE",
      }))
    );

    // 3. Insert admin_profiles for authorized admins
    await db.insert(adminProfiles).values([
      {
        userId: superAdmin.id,
        department: "Executive & Trust Operations",
        title: "Chief Platform Administrator",
        isApproved: true,
        permissions: [
          "users:manage",
          "providers:verify",
          "centers:manage",
          "bookings:manage",
          "incidents:manage",
          "settings:manage",
          "audit:read",
        ],
        provisionedBy: superAdmin.id,
      },
      {
        userId: mainAdmin.id,
        department: "Trust, Safety & Compliance",
        title: "Senior Childcare Operations Admin",
        isApproved: true,
        permissions: [
          "users:manage",
          "providers:verify",
          "centers:manage",
          "bookings:manage",
          "incidents:manage",
          "settings:manage",
          "audit:read",
        ],
        provisionedBy: superAdmin.id,
      },
      {
        userId: gmailAdmin.id,
        department: "Provider Verification & Quality",
        title: "Compliance Administrator",
        isApproved: true,
        permissions: [
          "users:manage",
          "providers:verify",
          "centers:manage",
          "bookings:manage",
          "incidents:manage",
          "audit:read",
        ],
        provisionedBy: superAdmin.id,
      },
      {
        userId: suspendedAdmin.id,
        department: "Operations",
        title: "Regional Admin",
        isApproved: false,
        permissions: [],
        provisionedBy: superAdmin.id,
      },
    ]);

    // 4. Insert Providers
    const insertedProviders = await db
      .insert(providers)
      .values([
        {
          ownerUserId: byEmail["director@sunshinekids.org"].id,
          organizationName: "Sunshine Sprouts Childcare Network",
          registrationNumber: "LS-PRV-2026-101",
          taxId: "EIN-84-2910441",
          contactEmail: "director@sunshinekids.org",
          contactPhone: "+1 (555) 410-2001",
          website: "https://sunshinekids.org",
          address: "420 Evergreen Terrace, Suite 200",
          city: "Austin",
          state: "TX",
          postalCode: "78701",
          verificationStatus: "APPROVED",
          subscriptionTier: "ENTERPRISE_24X7",
          subscriptionActive: true,
          isPublished: true,
          yearsInOperation: 8,
          createdAt: daysAgo(105),
        },
        {
          ownerUserId: byEmail["founder@littleexplorers.io"].id,
          organizationName: "Little Explorers 24×7 Early Learning",
          registrationNumber: "LS-PRV-2026-102",
          taxId: "EIN-92-5102938",
          contactEmail: "founder@littleexplorers.io",
          contactPhone: "+1 (555) 410-2002",
          website: "https://littleexplorers.io",
          address: "890 Innovation Way",
          city: "Seattle",
          state: "WA",
          postalCode: "98101",
          verificationStatus: "APPROVED",
          subscriptionTier: "PRO_CARE",
          subscriptionActive: true,
          isPublished: true,
          yearsInOperation: 5,
          createdAt: daysAgo(48),
        },
        {
          ownerUserId: byEmail["contact@brightbeginnings.care"].id,
          organizationName: "Bright Beginnings Montessori & Night Care",
          registrationNumber: "LS-PRV-2026-103",
          taxId: "EIN-77-6612094",
          contactEmail: "contact@brightbeginnings.care",
          contactPhone: "+1 (555) 410-2003",
          website: "https://brightbeginnings.care",
          address: "1150 Maple Avenue",
          city: "Denver",
          state: "CO",
          postalCode: "80203",
          verificationStatus: "PENDING",
          subscriptionTier: "PRO_CARE",
          subscriptionActive: true,
          isPublished: false,
          yearsInOperation: 3,
          createdAt: daysAgo(14),
        },
        {
          ownerUserId: byEmail["care@harmonychildcare.org"].id,
          organizationName: "Harmony Pediatric & Flexible Daycare",
          registrationNumber: "LS-PRV-2026-104",
          taxId: "EIN-63-8891201",
          contactEmail: "care@harmonychildcare.org",
          contactPhone: "+1 (555) 410-2004",
          website: "https://harmonychildcare.org",
          address: "742 Lakeshore Drive",
          city: "Chicago",
          state: "IL",
          postalCode: "60611",
          verificationStatus: "UNDER_REVIEW",
          subscriptionTier: "ENTERPRISE_24X7",
          subscriptionActive: true,
          isPublished: false,
          yearsInOperation: 6,
          createdAt: daysAgo(7),
        },
      ])
      .returning();

    const [pSunshine, pExplorers, pBright, pHarmony] = insertedProviders;

    // 5. Insert Centers
    const default24x7Hours = {
      Monday: { open: "00:00", close: "23:59", is24Hours: true },
      Tuesday: { open: "00:00", close: "23:59", is24Hours: true },
      Wednesday: { open: "00:00", close: "23:59", is24Hours: true },
      Thursday: { open: "00:00", close: "23:59", is24Hours: true },
      Friday: { open: "00:00", close: "23:59", is24Hours: true },
      Saturday: { open: "00:00", close: "23:59", is24Hours: true },
      Sunday: { open: "00:00", close: "23:59", is24Hours: true },
    };

    const insertedCenters = await db
      .insert(centers)
      .values([
        {
          providerId: pSunshine.id,
          name: "Sunshine Sprouts — Downtown 24×7 Hub",
          slug: "sunshine-sprouts-downtown-austin",
          description:
            "Flagship 24×7 accredited childcare centre with biometric check-in, pediatric nurse on duty, and sensory playrooms.",
          address: "420 Evergreen Terrace, Suite 200",
          city: "Austin",
          state: "TX",
          postalCode: "78701",
          phone: "+1 (555) 410-2010",
          email: "austin@sunshinekids.org",
          ageGroupsSupported: [
            "Infant (0-12m)",
            "Toddler (1-3y)",
            "Preschool (3-5y)",
            "School Age (5-10y)",
          ],
          operatingHours: default24x7Hours,
          is24x7: true,
          approvedCapacity: 40,
          currentOccupancy: 31,
          hourlyRate: "22.00",
          dailyRate: "145.00",
          verificationStatus: "APPROVED",
          listingStatus: "ACTIVE",
          rating: "4.95",
          createdAt: daysAgo(100),
        },
        {
          providerId: pExplorers.id,
          name: "Little Explorers — South Lake Union",
          slug: "little-explorers-south-lake-union",
          description:
            "Flexible daytime, evening, and weekend care tailored for healthcare and shift-working families.",
          address: "890 Innovation Way",
          city: "Seattle",
          state: "WA",
          postalCode: "98101",
          phone: "+1 (555) 410-2020",
          email: "slu@littleexplorers.io",
          ageGroupsSupported: [
            "Infant (0-12m)",
            "Toddler (1-3y)",
            "Preschool (3-5y)",
          ],
          operatingHours: default24x7Hours,
          is24x7: true,
          approvedCapacity: 30,
          currentOccupancy: 24,
          hourlyRate: "24.50",
          dailyRate: "160.00",
          verificationStatus: "APPROVED",
          listingStatus: "ACTIVE",
          rating: "4.88",
          createdAt: daysAgo(45),
        },
        {
          providerId: pBright.id,
          name: "Bright Beginnings Capitol Hill",
          slug: "bright-beginnings-capitol-hill-denver",
          description:
            "Montessori-inspired daycare centre awaiting final fire safety and state license verification.",
          address: "1150 Maple Avenue",
          city: "Denver",
          state: "CO",
          postalCode: "80203",
          phone: "+1 (555) 410-2030",
          email: "capitolhill@brightbeginnings.care",
          ageGroupsSupported: ["Toddler (1-3y)", "Preschool (3-5y)"],
          operatingHours: {
            Monday: { open: "06:30", close: "21:00" },
            Tuesday: { open: "06:30", close: "21:00" },
            Wednesday: { open: "06:30", close: "21:00" },
            Thursday: { open: "06:30", close: "21:00" },
            Friday: { open: "06:30", close: "22:00" },
            Saturday: { open: "08:00", close: "18:00" },
            Sunday: { open: "08:00", close: "18:00" },
          },
          is24x7: false,
          approvedCapacity: 25,
          currentOccupancy: 0,
          hourlyRate: "19.00",
          dailyRate: "125.00",
          verificationStatus: "PENDING",
          listingStatus: "PENDING_APPROVAL",
          rating: "4.75",
          createdAt: daysAgo(14),
        },
        {
          providerId: pHarmony.id,
          name: "Harmony 24×7 Hospital District Centre",
          slug: "harmony-hospital-district-chicago",
          description:
            "Dedicated 24×7 infant and toddler care adjacent to Northwestern Medical Campus.",
          address: "742 Lakeshore Drive",
          city: "Chicago",
          state: "IL",
          postalCode: "60611",
          phone: "+1 (555) 410-2040",
          email: "lakeshore@harmonychildcare.org",
          ageGroupsSupported: [
            "Infant (0-12m)",
            "Toddler (1-3y)",
            "Preschool (3-5y)",
          ],
          operatingHours: default24x7Hours,
          is24x7: true,
          approvedCapacity: 35,
          currentOccupancy: 12,
          hourlyRate: "26.00",
          dailyRate: "170.00",
          verificationStatus: "UNDER_REVIEW",
          listingStatus: "PENDING_APPROVAL",
          rating: "4.90",
          createdAt: daysAgo(7),
        },
      ])
      .returning();

    const [cSunshine, cExplorers, cBright, cHarmony] = insertedCenters;

    // 6. Insert Caregivers
    await db.insert(caregivers).values([
      {
        centerId: cSunshine.id,
        fullName: "Meera Krishnan",
        email: "meera.k@sunshinekids.org",
        phone: "+1 (555) 510-0011",
        roleTitle: "Head Early Childhood Educator",
        certifications: ["Pediatric CPR & First Aid", "CDA Infant/Toddler", "State Background Cleared"],
        backgroundCheckStatus: "VERIFIED",
        yearsExperience: 9,
      },
      {
        centerId: cSunshine.id,
        fullName: "Hannah Abbott",
        email: "hannah.a@sunshinekids.org",
        phone: "+1 (555) 510-0012",
        roleTitle: "Registered Pediatric Nurse & Night Lead",
        certifications: ["RN License #TX-44219", "Pediatric Advanced Life Support"],
        backgroundCheckStatus: "VERIFIED",
        yearsExperience: 7,
      },
      {
        centerId: cExplorers.id,
        fullName: "Liam O'Connor",
        email: "liam@littleexplorers.io",
        phone: "+1 (555) 510-0021",
        roleTitle: "Senior Toddler Care Specialist",
        certifications: ["Pediatric CPR", "Early STEM Educator"],
        backgroundCheckStatus: "VERIFIED",
        yearsExperience: 5,
      },
      {
        centerId: cBright.id,
        fullName: "Sofia Martinez",
        email: "sofia@brightbeginnings.care",
        phone: "+1 (555) 510-0031",
        roleTitle: "AMS Montessori Lead Guide",
        certifications: ["AMS Early Childhood Credential", "First Aid Certified"],
        backgroundCheckStatus: "VERIFIED",
        yearsExperience: 6,
      },
      {
        centerId: cHarmony.id,
        fullName: "Amara Okafor",
        email: "amara@harmonychildcare.org",
        phone: "+1 (555) 510-0041",
        roleTitle: "Infant Care Supervisor",
        certifications: ["Neonatal & Infant Safe Sleep", "Pediatric CPR"],
        backgroundCheckStatus: "VERIFIED",
        yearsExperience: 8,
      },
    ]);

    // 7. Insert Capacity Rules
    await db.insert(capacityRules).values([
      {
        centerId: cSunshine.id,
        ageGroup: "Infant (0-12m)",
        maxChildren: 8,
        caregiverRatio: "1:3",
      },
      {
        centerId: cSunshine.id,
        ageGroup: "Toddler (1-3y)",
        maxChildren: 14,
        caregiverRatio: "1:4",
      },
      {
        centerId: cSunshine.id,
        ageGroup: "Preschool (3-5y)",
        maxChildren: 18,
        caregiverRatio: "1:8",
      },
      {
        centerId: cExplorers.id,
        ageGroup: "Toddler (1-3y)",
        maxChildren: 15,
        caregiverRatio: "1:4",
      },
      {
        centerId: cBright.id,
        ageGroup: "Preschool (3-5y)",
        maxChildren: 25,
        caregiverRatio: "1:8",
      },
    ]);

    // 8. Insert Verification Documents & Provider Verifications
    const insertedDocs = await db
      .insert(verificationDocuments)
      .values([
        {
          providerId: pSunshine.id,
          centerId: cSunshine.id,
          documentType: "CHILDCARE_LICENSE",
          documentTitle: "Texas DFPS 24×7 Licensed Child-Care Center Permit #TX-99812",
          storageReference: "private://vault/providers/sunshine/tx-dfps-license-2026.pdf",
          mimeType: "application/pdf",
          fileSizeBytes: 842_190,
          checksumSha256: "a91f4c829b120e8891234abcd9981234ef0123456789abcdef0123456789abcd",
          status: "VERIFIED",
          expiresAt: daysAgo(-365),
          uploadedBy: byEmail["director@sunshinekids.org"].id,
          reviewedBy: mainAdmin.id,
          reviewedAt: daysAgo(98),
          reviewNotes: "Verified directly against Texas HHSC public registry.",
        },
        {
          providerId: pBright.id,
          centerId: cBright.id,
          documentType: "CHILDCARE_LICENSE",
          documentTitle: "Colorado CDEC Provisional Daycare License Application",
          storageReference: "private://vault/providers/bright/co-cdec-license-2026.pdf",
          mimeType: "application/pdf",
          fileSizeBytes: 615_400,
          checksumSha256: "b72e4c829b120e8891234abcd9981234ef0123456789abcdef01234567891111",
          status: "SUBMITTED",
          expiresAt: daysAgo(-300),
          uploadedBy: byEmail["contact@brightbeginnings.care"].id,
        },
        {
          providerId: pBright.id,
          centerId: cBright.id,
          documentType: "FIRE_SAFETY_CERTIFICATE",
          documentTitle: "Denver Fire Department Annual Facility Inspection Report",
          storageReference: "private://vault/providers/bright/denver-fire-inspection.pdf",
          mimeType: "application/pdf",
          fileSizeBytes: 512_000,
          checksumSha256: "c83f4c829b120e8891234abcd9981234ef0123456789abcdef01234567892222",
          status: "SUBMITTED",
          expiresAt: daysAgo(-280),
          uploadedBy: byEmail["contact@brightbeginnings.care"].id,
        },
        {
          providerId: pHarmony.id,
          centerId: cHarmony.id,
          documentType: "CHILDCARE_LICENSE",
          documentTitle: "Illinois DCFS Day Care Center License #IL-44821",
          storageReference: "private://vault/providers/harmony/il-dcfs-license.pdf",
          mimeType: "application/pdf",
          fileSizeBytes: 912_300,
          checksumSha256: "d94f4c829b120e8891234abcd9981234ef0123456789abcdef01234567893333",
          status: "SUBMITTED",
          expiresAt: daysAgo(-320),
          uploadedBy: byEmail["care@harmonychildcare.org"].id,
        },
        {
          providerId: pHarmony.id,
          centerId: cHarmony.id,
          documentType: "BACKGROUND_CHECK",
          documentTitle: "FBI & Illinois State Police Fingerprint Clearance Roster",
          storageReference: "private://vault/providers/harmony/staff-background-clearance.pdf",
          mimeType: "application/pdf",
          fileSizeBytes: 740_120,
          checksumSha256: "e05f4c829b120e8891234abcd9981234ef0123456789abcdef01234567894444",
          status: "SUBMITTED",
          expiresAt: daysAgo(-350),
          uploadedBy: byEmail["care@harmonychildcare.org"].id,
        },
      ])
      .returning();

    await db.insert(providerVerifications).values([
      {
        providerId: pSunshine.id,
        status: "APPROVED",
        reviewerId: mainAdmin.id,
        submittedAt: daysAgo(102),
        reviewedAt: daysAgo(98),
        reviewComments:
          "All state permits, 24×7 nurse staffing ratios, and facility fire inspections verified.",
        documentReferences: [insertedDocs[0].id],
        checklistState: {
          licenseVerified: true,
          backgroundChecksVerified: true,
          facilitySafetyVerified: true,
          insuranceVerified: true,
        },
        expiresAt: daysAgo(-365),
      },
      {
        providerId: pExplorers.id,
        status: "APPROVED",
        reviewerId: superAdmin.id,
        submittedAt: daysAgo(47),
        reviewedAt: daysAgo(45),
        reviewComments:
          "Washington DCYF license and overnight emergency protocols approved.",
        documentReferences: [],
        checklistState: {
          licenseVerified: true,
          backgroundChecksVerified: true,
          facilitySafetyVerified: true,
          insuranceVerified: true,
        },
        expiresAt: daysAgo(-340),
      },
      {
        providerId: pBright.id,
        status: "PENDING",
        submittedAt: daysAgo(5),
        reviewComments: "Awaiting initial compliance officer review.",
        documentReferences: [insertedDocs[1].id, insertedDocs[2].id],
        checklistState: {
          licenseVerified: false,
          backgroundChecksVerified: true,
          facilitySafetyVerified: false,
          insuranceVerified: true,
        },
      },
      {
        providerId: pHarmony.id,
        status: "UNDER_REVIEW",
        reviewerId: gmailAdmin.id,
        submittedAt: daysAgo(3),
        reviewComments:
          "License and fingerprint roster under verification with Illinois DCFS.",
        documentReferences: [insertedDocs[3].id, insertedDocs[4].id],
        checklistState: {
          licenseVerified: true,
          backgroundChecksVerified: true,
          facilitySafetyVerified: false,
          insuranceVerified: true,
        },
      },
    ]);

    // 9. Insert Children & Bookings
    const insertedChildren = await db
      .insert(children)
      .values([
        {
          parentId: byEmail["ananya.patel@example.com"].id,
          firstName: "Aarav",
          ageMonths: 28,
          ageGroup: "Toddler (1-3y)",
          hasMedicalNotes: false,
          emergencyContactPhone: "+1 (555) 310-1002",
        },
        {
          parentId: byEmail["david.chen@example.com"].id,
          firstName: "Maya",
          ageMonths: 46,
          ageGroup: "Preschool (3-5y)",
          hasMedicalNotes: true,
          emergencyContactPhone: "+1 (555) 310-1003",
        },
        {
          parentId: byEmail["sarah.jenkins@example.com"].id,
          firstName: "Leo",
          ageMonths: 10,
          ageGroup: "Infant (0-12m)",
          hasMedicalNotes: false,
          emergencyContactPhone: "+1 (555) 310-1004",
        },
      ])
      .returning();

    const [childAarav, childMaya, childLeo] = insertedChildren;

    const insertedBookings = await db
      .insert(bookings)
      .values([
        {
          bookingReference: "LS-BK-2026-1001",
          parentId: byEmail["ananya.patel@example.com"].id,
          childId: childAarav.id,
          providerId: pSunshine.id,
          centerId: cSunshine.id,
          status: "CONFIRMED",
          careType: "OVERNIGHT_24X7",
          startTime: hoursFromNow(6),
          endTime: hoursFromNow(18),
          totalAmount: "185.00",
          paymentStatus: "PAID",
          hasConflict: false,
          notes: "Parent on overnight ER hospital shift.",
          createdAt: daysAgo(4),
        },
        {
          bookingReference: "LS-BK-2026-1002",
          parentId: byEmail["david.chen@example.com"].id,
          childId: childMaya.id,
          providerId: pExplorers.id,
          centerId: cExplorers.id,
          status: "CHECKED_IN",
          careType: "FULL_DAY",
          startTime: hoursFromNow(-3),
          endTime: hoursFromNow(5),
          totalAmount: "160.00",
          paymentStatus: "PAID",
          hasConflict: false,
          notes: "Checked in via parent QR pass at 08:30.",
          createdAt: daysAgo(6),
        },
        {
          bookingReference: "LS-BK-2026-1003",
          parentId: byEmail["sarah.jenkins@example.com"].id,
          childId: childLeo.id,
          providerId: pSunshine.id,
          centerId: cSunshine.id,
          status: "REQUESTED",
          careType: "EMERGENCY_DROP_IN",
          startTime: hoursFromNow(12),
          endTime: hoursFromNow(20),
          totalAmount: "176.00",
          paymentStatus: "PENDING",
          hasConflict: false,
          notes: "Infant room slot requested.",
          createdAt: daysAgo(1),
        },
        {
          bookingReference: "LS-BK-2026-1004",
          parentId: byEmail["ananya.patel@example.com"].id,
          childId: childAarav.id,
          providerId: pExplorers.id,
          centerId: cExplorers.id,
          status: "COMPLETED",
          careType: "FULL_DAY",
          startTime: daysAgo(10),
          endTime: daysAgo(10),
          totalAmount: "160.00",
          paymentStatus: "PAID",
          hasConflict: false,
          createdAt: daysAgo(12),
        },
        {
          bookingReference: "LS-BK-2026-1005",
          parentId: byEmail["david.chen@example.com"].id,
          childId: childMaya.id,
          providerId: pSunshine.id,
          centerId: cSunshine.id,
          status: "CANCELLED",
          careType: "HOURLY",
          startTime: daysAgo(5),
          endTime: daysAgo(5),
          totalAmount: "88.00",
          paymentStatus: "DISPUTED",
          hasConflict: false,
          cancellationReason: "Flight delay — parent requested fee waiver.",
          createdAt: daysAgo(7),
        },
      ])
      .returning();

    await db.insert(bookingStatusHistory).values([
      {
        bookingId: insertedBookings[0].id,
        fromStatus: "REQUESTED",
        toStatus: "CONFIRMED",
        changedBy: byEmail["director@sunshinekids.org"].id,
        reason: "Caregiver ratio verified for overnight shift.",
      },
      {
        bookingId: insertedBookings[1].id,
        fromStatus: "CONFIRMED",
        toStatus: "CHECKED_IN",
        changedBy: byEmail["founder@littleexplorers.io"].id,
        reason: "Child checked in with verified parent guardian ID.",
      },
      {
        bookingId: insertedBookings[4].id,
        fromStatus: "CONFIRMED",
        toStatus: "CANCELLED",
        changedBy: byEmail["david.chen@example.com"].id,
        reason: "Parent cancelled 3 hours before start due to travel delay.",
      },
    ]);

    // 10. Insert Disputes
    await db.insert(disputes).values([
      {
        disputeReference: "LS-DSP-2026-019",
        bookingId: insertedBookings[4].id,
        raisedByUserId: byEmail["david.chen@example.com"].id,
        reason: "Late Cancellation Fee Waiver Request",
        description:
          "Parent provided airline delay documentation and requested a 50% credit on the late cancellation charge.",
        status: "OPEN",
      },
    ]);

    // 11. Insert Safety Incidents & Activity
    const insertedIncidents = await db
      .insert(safetyIncidents)
      .values([
        {
          incidentReference: "LS-INC-2026-0041",
          centerId: cSunshine.id,
          bookingId: insertedBookings[0].id,
          reportedByUserId: byEmail["director@sunshinekids.org"].id,
          assignedAdminId: mainAdmin.id,
          category: "HEALTH_AND_INJURY",
          severity: "LOW",
          status: "INVESTIGATING",
          title: "Minor Playground Knee Scrape — Outdoor Play Area",
          description:
            "Toddler tripped on soft turf mat during supervised morning outdoor play. First aid antiseptic and bandage applied immediately by on-duty pediatric nurse; parent notified within 10 minutes.",
          occurredAt: daysAgo(2),
        },
        {
          incidentReference: "LS-INC-2026-0042",
          centerId: cExplorers.id,
          bookingId: insertedBookings[1].id,
          reportedByUserId: byEmail["david.chen@example.com"].id,
          assignedAdminId: superAdmin.id,
          category: "CHECK_IN_SECURITY",
          severity: "HIGH",
          status: "UNDER_REVIEW",
          title: "Unlisted Relative Attempted Pickup Without Pre-Authorization Pin",
          description:
            "An extended family member arrived for pickup without an active digital pickup pass. Front desk staff properly denied release and contacted primary parent for verification.",
          occurredAt: daysAgo(1),
        },
        {
          incidentReference: "LS-INC-2026-0039",
          centerId: cSunshine.id,
          reportedByUserId: byEmail["director@sunshinekids.org"].id,
          assignedAdminId: mainAdmin.id,
          category: "FACILITY_HAZARD",
          severity: "MEDIUM",
          status: "RESOLVED",
          title: "HVAC Thermostat Sensor Replacement in Nap Room B",
          description:
            "Backup climate unit engaged automatically when primary sensor drifted by 3°F. Technician replaced sensor within 2 hours.",
          resolutionOutcome:
            "Sensor replaced, calibration certificate uploaded, and 48-hour temperature log verified.",
          occurredAt: daysAgo(9),
          resolvedAt: daysAgo(8),
        },
      ])
      .returning();

    await db.insert(incidentActivity).values([
      {
        incidentId: insertedIncidents[0].id,
        actorId: mainAdmin.id,
        actionType: "STATUS_CHANGED",
        fromStatus: "REPORTED",
        toStatus: "INVESTIGATING",
        note: "Assigned to Priya Sharma. Requested nurse incident log and parent acknowledgement receipt.",
      },
      {
        incidentId: insertedIncidents[1].id,
        actorId: superAdmin.id,
        actionType: "STATUS_CHANGED",
        fromStatus: "REPORTED",
        toStatus: "UNDER_REVIEW",
        note: "Reviewing lobby access control logs; centre staff followed strict child-release protocol.",
      },
      {
        incidentId: insertedIncidents[2].id,
        actorId: mainAdmin.id,
        actionType: "RESOLUTION_RECORDED",
        fromStatus: "INVESTIGATING",
        toStatus: "RESOLVED",
        note: "Verified HVAC repair invoice and continuous temperature telemetry.",
      },
    ]);

    // 12. Insert Notifications
    await db.insert(notifications).values([
      {
        audienceRole: "ADMIN",
        type: "VERIFICATION_SUBMITTED",
        title: "New Provider Verification Pending",
        message:
          "Bright Beginnings Montessori & Night Care submitted 2 compliance documents for review.",
        entityType: "PROVIDER_VERIFICATION",
        entityId: pBright.id,
        isRead: false,
      },
      {
        audienceRole: "ADMIN",
        type: "INCIDENT_REPORTED",
        title: "High-Priority Security Report Logged",
        message:
          "Incident LS-INC-2026-0042 (Check-in Security) requires administrative review.",
        entityType: "SAFETY_INCIDENT",
        entityId: insertedIncidents[1].id,
        isRead: false,
      },
      {
        audienceRole: "ADMIN",
        type: "DISPUTE_OPENED",
        title: "Booking Dispute Opened (LS-DSP-2026-019)",
        message:
          "Parent requested cancellation fee review for booking LS-BK-2026-1005.",
        entityType: "DISPUTE",
        entityId: insertedBookings[4].id,
        isRead: false,
      },
    ]);

    // 13. Insert Platform Settings
    await db.insert(platformSettings).values([
      {
        settingKey: "security.otp_expiry_minutes",
        settingValue: 5,
        category: "SECURITY",
        description: "Expiration window (in minutes) for 6-digit Admin Email OTP challenges.",
        updatedByAdminId: superAdmin.id,
      },
      {
        settingKey: "security.max_otp_attempts",
        settingValue: 5,
        category: "SECURITY",
        description: "Maximum failed OTP verification attempts before challenge lock.",
        updatedByAdminId: superAdmin.id,
      },
      {
        settingKey: "security.require_admin_email_keyword",
        settingValue: true,
        category: "SECURITY",
        description: "Enforce 'admin' keyword presence in addition to explicit role & profile approval.",
        updatedByAdminId: superAdmin.id,
      },
      {
        settingKey: "verification.require_dual_document_check",
        settingValue: true,
        category: "VERIFICATION",
        description: "Require both state childcare license and fire safety inspection before center activation.",
        updatedByAdminId: superAdmin.id,
      },
      {
        settingKey: "bookings.enforce_strict_capacity_guard",
        settingValue: true,
        category: "BOOKINGS",
        description: "Prevent booking confirmations that exceed a centre's approved capacity.",
        updatedByAdminId: superAdmin.id,
      },
      {
        settingKey: "notifications.incident_escalation_email",
        settingValue: "superadmin@littlesteps.com",
        category: "NOTIFICATIONS",
        description: "Primary escalation address for HIGH and CRITICAL safety incidents.",
        updatedByAdminId: superAdmin.id,
      },
    ]);

    // 14. Insert Initial Tamper-Evident Audit Logs
    const t1 = daysAgo(98).toISOString();
    const t2 = daysAgo(45).toISOString();
    await db.insert(adminAuditLogs).values([
      {
        adminUserId: mainAdmin.id,
        adminEmail: mainAdmin.email,
        action: "PROVIDER_VERIFICATION_APPROVED",
        entityType: "PROVIDER",
        entityId: pSunshine.id,
        summary:
          "Approved provider verification for Sunshine Sprouts Childcare Network after license & nurse staffing check.",
        previousState: { status: "UNDER_REVIEW", isPublished: false },
        newState: { status: "APPROVED", isPublished: true },
        ipAddress: "127.0.0.1",
        integrityHash: computeAuditIntegrityHash({
          adminEmail: mainAdmin.email,
          action: "PROVIDER_VERIFICATION_APPROVED",
          entityType: "PROVIDER",
          entityId: pSunshine.id,
          summary:
            "Approved provider verification for Sunshine Sprouts Childcare Network after license & nurse staffing check.",
          timestampIso: t1,
        }),
        createdAt: new Date(t1),
      },
      {
        adminUserId: superAdmin.id,
        adminEmail: superAdmin.email,
        action: "PROVIDER_VERIFICATION_APPROVED",
        entityType: "PROVIDER",
        entityId: pExplorers.id,
        summary:
          "Approved provider verification for Little Explorers 24×7 Early Learning.",
        previousState: { status: "UNDER_REVIEW", isPublished: false },
        newState: { status: "APPROVED", isPublished: true },
        ipAddress: "127.0.0.1",
        integrityHash: computeAuditIntegrityHash({
          adminEmail: superAdmin.email,
          action: "PROVIDER_VERIFICATION_APPROVED",
          entityType: "PROVIDER",
          entityId: pExplorers.id,
          summary:
            "Approved provider verification for Little Explorers 24×7 Early Learning.",
          timestampIso: t2,
        }),
        createdAt: new Date(t2),
      },
    ]);

    isSeededInProcess = true;
  } catch (error) {
    console.error("[LittleSteps Seed] Non-fatal error checking seed data:", error);
  }
}

export async function getDatabaseHealthCount(): Promise<number> {
  const res = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  return res[0]?.count ?? 0;
}
