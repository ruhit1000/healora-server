import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import {
  MongoClient,
  ServerApiVersion,
  ObjectId,
  Db,
  Collection,
} from "mongodb";
import dns from "dns";
import dotenv from "dotenv";
import Stripe from "stripe";

dotenv.config();

dns.setServers(["8.8.8.8", "1.1.1.1"]);

const app = express();
const port = process.env.PORT || 8000;
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY as string);
const clientUrl = process.env.CLIENT_URL || "http://localhost:3000";

// Universal Middleware Layout - Locked down to your specific frontend URL
app.use(cors({
  origin: clientUrl
}));

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET as string;

/* =========================================================================
   ⚠️ STRIPE WEBHOOK (MUST GO BEFORE express.json() IS CALLED)
   ========================================================================= */
app.post(
  "/api/webhooks/stripe",
  express.raw({ type: "application/json" }),
  async (req: Request, res: Response) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
      event = stripe.webhooks.constructEvent(
        req.body,
        sig as string,
        endpointSecret,
      );
    } catch (err: any) {
      console.error(`Webhook signature verification failed: ${err.message}`);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object as Stripe.Checkout.Session;
      const bookingId = session.metadata?.bookingId;

      if (bookingId) {
        try {
          await bookingsCollection.updateOne(
            { _id: new ObjectId(bookingId) },
            {
              $set: {
                paymentStatus: "Paid",
                bookingStatus: "Confirmed",
                updatedAt: new Date(),
              },
              $unset: {
                lockExpiresAt: "",
              },
            },
          );
          console.log(`✅ SUCCESS: Booking ${bookingId} confirmed and paid.`);
        } catch (dbError) {
          console.error("Failed to update booking status in MongoDB:", dbError);
        }
      }
    }

    res.status(200).send();
  },
);

// NOW you can apply standard JSON parsing for all the other routes
app.use(express.json());

interface AuthenticatedRequest extends Request {
  user?: any;
}

// Database Connection Orchestration
const uri = process.env.MONGO_URI || "";
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let database: Db;
let sessionsCollection: Collection;
let usersCollection: Collection;
let doctorsCollection: Collection;
let bookingsCollection: Collection; 
let profilesCollection: Collection;

async function bootstrapServer() {
  try {
    await client.connect();
    console.log("🍃 MongoDB connected successfully via native driver");

    database = client.db("healora_db");

    sessionsCollection = database.collection("session");
    usersCollection = database.collection("user");
    doctorsCollection = database.collection("doctors");
    bookingsCollection = database.collection("bookings"); 
    profilesCollection = database.collection("profiles");

    await profilesCollection.createIndex({ userId: 1 }, { unique: true });
    console.log("👤 Unique index established on profilesCollection");

    // 1. Auto-Delete TTL Index for abandoned checkouts
    await bookingsCollection.createIndex(
      { lockExpiresAt: 1 },
      { expireAfterSeconds: 0 },
    );
    console.log("⏱️ TTL Index established on bookingsCollection");

    // 2. Strict Unique Index to prevent millisecond race-condition double bookings
    await bookingsCollection.createIndex(
      { doctorId: 1, appointmentDate: 1, appointmentTime: 1 },
      { unique: true }
    );
    console.log("🔒 Unique constraint index established on bookingsCollection");

    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } catch (error) {
    console.error("❌ Failed to bind native MongoDB instance:", error);
  }
}
bootstrapServer();

/* =========================================================================
       1. CUSTOM DATABASE SESSION VERIFICATION MIDDLEWARE
       ========================================================================= */
const verifyToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).send({ message: "Unauthorized Access" });
    }

    const token = authHeader.split(" ")[1];
    if (!token) {
      return res.status(401).send({ message: "Unauthorized Access" });
    }

    const session = await sessionsCollection.findOne({ token: token });
    if (!session) {
      return res.status(401).send({ message: "Unauthorized Access" });
    }

    const user = await usersCollection.findOne({
      _id: new ObjectId(session.userId as string),
    });
    if (!user) {
      return res.status(401).send({ message: "Unauthorized Access" });
    }

    req.user = user;
    next();
  } catch (error: any) {
    return res
      .status(500)
      .send({ message: "Internal Auth Exception", error: error.message });
  }
};

/* =========================================================================
       2. ROLE SPECIFIC VERIFICATION MIDDLEWARES
       ========================================================================= */
const verifyAdmin = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  if (req.user?.role !== "admin") {
    return res.status(403).send({ message: "Forbidden Access" });
  }
  next();
};

const verifyDoctor = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  if (req.user?.role !== "doctor") {
    return res.status(403).send({ message: "Forbidden Access" });
  }
  next();
};

const verifyPatient = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  if (req.user?.role !== "patient") {
    return res.status(403).send({ message: "Forbidden Access" });
  }
  next();
};

/* =========================================================================
       3. CORE API ENDPOINTS
       ========================================================================= */

app.get("/", (req: Request, res: Response) => {
  res.send("Healora Secure Medical Scheduling Backend: ONLINE");
});

app.get("/api/doctors", async (req: Request, res: Response) => {
  try {
    const { search, specialty, page } = req.query;
    const filterQuery: any = { isApproved: true };

    if (search && typeof search === "string") {
      filterQuery.name = { $regex: search, $options: "i" };
    }
    if (specialty && typeof specialty === "string") {
      filterQuery.specialty = specialty;
    }

    const itemsPerPage = 12;
    const currentPage = page ? parseInt(page as string, 10) : 1;
    const skipCount = (currentPage - 1) * itemsPerPage;
    const totalMatchingDoctors =
      await doctorsCollection.countDocuments(filterQuery);
    const totalPages = Math.ceil(totalMatchingDoctors / itemsPerPage);

    const doctors = await doctorsCollection
      .find(filterQuery)
      .project({
        name: 1,
        title: 1,
        image: 1,
        specialty: 1,
        fee: 1,
        location: 1,
        availabilitySummary: 1,
        patientSatisfactoryScore: { averageRating: 1 },
      })
      .skip(skipCount)
      .limit(itemsPerPage)
      .toArray();

    res.status(200).json({
      success: true,
      meta: {
        totalDoctors: totalMatchingDoctors,
        totalPages,
        currentPage,
        limit: itemsPerPage,
      },
      data: doctors,
    });
  } catch (error: any) {
    res
      .status(500)
      .json({
        success: false,
        message: "Failed to parse directory",
        error: error.message,
      });
  }
});

app.get("/api/doctors/specialties", async (req: Request, res: Response) => {
  try {
    const aggregationResult = await doctorsCollection
      .aggregate([
        { $match: { isApproved: { $in: [true, "true"] } } },
        { $group: { _id: "$specialty" } },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    const cleanSpecialties = aggregationResult
      .map((item) => item._id)
      .filter(
        (spec): spec is string =>
          typeof spec === "string" && spec.trim() !== "",
      );

    res.status(200).json({ success: true, data: cleanSpecialties });
  } catch (error: any) {
    res
      .status(500)
      .json({
        success: false,
        message: "Failed to compile specialty registry",
        error: error.message,
      });
  }
});

app.get("/api/doctors/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== "string" || !ObjectId.isValid(id)) {
      return res
        .status(400)
        .json({ success: false, message: "Invalid Doctor ID format" });
    }

    const doctor = await doctorsCollection.findOne({ _id: new ObjectId(id) });
    if (!doctor) {
      return res
        .status(404)
        .json({ success: false, message: "Profile not found" });
    }
    if (doctor.isApproved !== true && doctor.isApproved !== "true") {
      return res
        .status(403)
        .json({ success: false, message: "Profile pending verification" });
    }

    res.status(200).json({ success: true, data: doctor });
  } catch (error: any) {
    res
      .status(500)
      .json({ success: false, message: "Server error", error: error.message });
  }
});

/* =========================================================================
       4. BOOKING & CHECKOUT ENGINE
       ========================================================================= */

app.get("/api/bookings/schedule", async (req: Request, res: Response) => {
  try {
    const { doctorId, date } = req.query;

    if (
      !doctorId ||
      typeof doctorId !== "string" ||
      !date ||
      typeof date !== "string"
    ) {
      return res
        .status(400)
        .json({ success: false, message: "Doctor ID and date required" });
    }

    const bookedSlots = await bookingsCollection
      .find({
        doctorId: new ObjectId(doctorId),
        appointmentDate: date,
        bookingStatus: { $in: ["Locked", "Confirmed"] },
      })
      .project({ appointmentTime: 1 })
      .toArray();

    const disabledTimes = bookedSlots.map((b) => b.appointmentTime);

    res.status(200).json({ success: true, data: disabledTimes });
  } catch (error: any) {
    res
      .status(500)
      .json({
        success: false,
        message: "Failed to fetch schedule",
        error: error.message,
      });
  }
});

app.post(
  "/api/bookings/initialize",
  verifyToken,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { doctorId, appointmentDate, appointmentTime, intake } = req.body;
      const patientUserId = req.user._id;

      const existingBooking = await bookingsCollection.findOne({
        doctorId: new ObjectId(doctorId as string),
        appointmentDate,
        appointmentTime,
        bookingStatus: { $in: ["Locked", "Confirmed"] },
      });

      if (existingBooking) {
        return res.status(409).json({
          success: false,
          message:
            "This slot was just booked by someone else. Please choose another time.",
        });
      }

      const doctor = await doctorsCollection.findOne({
        _id: new ObjectId(doctorId as string),
      });
      if (!doctor) {
        return res
          .status(404)
          .json({ success: false, message: "Doctor not found." });
      }

      const now = new Date();
      const lockExpiration = new Date(now.getTime() + 10 * 60 * 1000);

      const newBookingDocument = {
        patientUserId: patientUserId, 
        doctorId: new ObjectId(doctorId as string),
        appointmentDate,
        appointmentTime,
        patientDetails: {
          patientName: intake.patientName,
          age: Number(intake.age),
          gender: intake.gender,
          reasonForVisit: intake.reason || "",
        },
        consultationFee: doctor.fee,
        bookingStatus: "Locked",
        paymentStatus: "Pending",
        lockExpiresAt: lockExpiration,
        createdAt: now,
        updatedAt: now,
      };

      const insertResult =
        await bookingsCollection.insertOne(newBookingDocument);
      const newBookingId = insertResult.insertedId.toString();

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        customer_email: req.user?.email || undefined, // Safely handles missing emails
        line_items: [
          {
            price_data: {
              currency: "bdt", // Swap to "usd" if your live Stripe rejects bdt
              product_data: {
                name: `Consultation with ${doctor.name}`,
                description: `${appointmentDate} @ ${appointmentTime} for ${intake.patientName}`,
              },
              unit_amount: Math.round(doctor.fee * 100), // Prevents crash from decimals
            },
            quantity: 1,
          },
        ],
        metadata: { bookingId: newBookingId },
        success_url: `${clientUrl}/booking-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${clientUrl}/doctors/${doctorId}?payment=cancelled`,
      });

      await bookingsCollection.updateOne(
        { _id: insertResult.insertedId },
        { $set: { stripeSessionId: session.id, updatedAt: new Date() } },
      );

      res.status(200).json({ success: true, url: session.url });
    } catch (error: any) {
      // Handles race condition rejection from the new unique index
      if (error.code === 11000) {
        return res.status(409).json({
          success: false,
          message: "This slot was just booked by someone else. Please choose another time.",
        });
      }

      console.error(error);
      res
        .status(500)
        .json({
          success: false,
          message: "Checkout failed",
          error: error.message,
        });
    }
  },
);

// Dashboard API Endpoints for Patients
app.get(
  "/api/patient/dashboard/overview",
  verifyToken,
  verifyPatient,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const patientUserId = req.user._id;

      // 1. Get today's date as a string (assuming appointmentDate is stored as YYYY-MM-DD)
      const today = new Date();
      // Adjusting for your timezone (Bangladesh) to ensure accurate "today" calculations
      const todayStr = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().split("T")[0];

      // 2. Fetch all upcoming confirmed bookings
      const upcomingBookings = await bookingsCollection
        .find({
          patientUserId: patientUserId,
          bookingStatus: "Confirmed",
          appointmentDate: { $gte: todayStr },
        })
        .sort({ appointmentDate: 1, appointmentTime: 1 })
        .toArray();

      const upcomingCount = upcomingBookings.length;
      let nextAppointment = upcomingBookings[0] || null;

      // If there is a next appointment, fetch the doctor's details for the UI card
      if (nextAppointment) {
        const doctor = await doctorsCollection.findOne(
          { _id: new ObjectId(nextAppointment.doctorId) },
          { projection: { name: 1, specialty: 1, location: 1, image: 1 } }
        );
        nextAppointment.doctorDetails = doctor;
      }

      // 3. Calculate total spent (Payment Status: Paid)
      const paidBookings = await bookingsCollection
        .find({ patientUserId: patientUserId, paymentStatus: "Paid" })
        .project({ consultationFee: 1 })
        .toArray();
      
      const totalSpent = paidBookings.reduce((sum, booking) => sum + (booking.consultationFee || 0), 0);

      // 4. Count total completed consultations
      const completedCount = await bookingsCollection.countDocuments({
        patientUserId: patientUserId,
        bookingStatus: "Completed",
      });

      // 5. Fetch Recent Activity (Last 3 appointments, either past dates or completed/cancelled)
      const recentActivity = await bookingsCollection
        .find({
          patientUserId: patientUserId,
          $or: [
            { bookingStatus: { $in: ["Completed", "Cancelled"] } },
            { appointmentDate: { $lt: todayStr } }
          ]
        })
        .sort({ appointmentDate: -1, createdAt: -1 })
        .limit(3)
        .toArray();

      // Attach doctor names to recent activity for the UI table
      const recentActivityWithDoctors = await Promise.all(
        recentActivity.map(async (activity) => {
          const doctor = await doctorsCollection.findOne(
            { _id: new ObjectId(activity.doctorId) },
            { projection: { name: 1, specialty: 1 } }
          );
          return { ...activity, doctorDetails: doctor };
        })
      );

      // 6. Send the aggregated payload
      res.status(200).json({
        success: true,
        data: {
          stats: {
            upcomingCount,
            completedCount,
            totalSpent,
          },
          nextAppointment,
          recentActivity: recentActivityWithDoctors,
        },
      });
    } catch (error: any) {
      console.error("Dashboard Overview Error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to load dashboard data",
        error: error.message,
      });
    }
  }
);

app.get(
  "/api/patient/dashboard/appointments",
  verifyToken,
  verifyPatient,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const patientUserId = req.user._id;

      // Get current date string (YYYY-MM-DD) for accurate future filtering
      const today = new Date();
      const todayStr = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().split("T")[0];

      // Fetch upcoming appointments that are either Confirmed or actively Locked
      const appointments = await bookingsCollection
        .find({
          patientUserId: patientUserId,
          bookingStatus: { $in: ["Confirmed", "Locked"] },
          appointmentDate: { $gte: todayStr },
        })
        .sort({ appointmentDate: 1, appointmentTime: 1 })
        .toArray();

      // Stitch doctor profile information onto each appointment payload
      const populatedAppointments = await Promise.all(
        appointments.map(async (appt) => {
          const doctor = await doctorsCollection.findOne(
            { _id: new ObjectId(appt.doctorId) },
            { projection: { name: 1, specialty: 1, image: 1, location: 1 } }
          );
          
          // Explicitly return the spread fields alongside doctorDetails
          return {
            ...appt,
            bookingStatus: appt.bookingStatus,
            doctorDetails: doctor
          };
        })
      );

      // Separate the appointments into active vs pending channels for frontend tabs
      const confirmed = populatedAppointments.filter(a => a.bookingStatus === "Confirmed");
      const pending = populatedAppointments.filter(a => a.bookingStatus === "Locked");

      res.status(200).json({
        success: true,
        data: {
          confirmed,
          pending
        }
      });
    } catch (error: any) {
      console.error("Fetch Patient Appointments Error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to load appointments",
        error: error.message,
      });
    }
  }
);

app.get(
  "/api/patient/dashboard/history",
  verifyToken,
  verifyPatient,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const patientUserId = req.user._id;

      const today = new Date();
      const todayStr = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().split("T")[0];

      // Fetch appointments that are either Completed, Cancelled, OR fall in the past
      const history = await bookingsCollection
        .find({
          patientUserId: patientUserId,
          $or: [
            { bookingStatus: { $in: ["Completed", "Cancelled"] } },
            { appointmentDate: { $lt: todayStr } }
          ]
        })
        .sort({ appointmentDate: -1, appointmentTime: -1 }) // Most recent past visits first
        .toArray();

      // Stitch doctor profile information onto each history item
      const populatedHistory = await Promise.all(
        history.map(async (appt) => {
          const doctor = await doctorsCollection.findOne(
            { _id: new ObjectId(appt.doctorId) },
            { projection: { name: 1, specialty: 1, image: 1 } }
          );
          
          return {
            ...appt,
            bookingStatus: appt.bookingStatus,
            doctorDetails: doctor
          };
        })
      );

      res.status(200).json({
        success: true,
        data: populatedHistory
      });
    } catch (error: any) {
      console.error("Fetch Patient History Error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to load consultation history",
        error: error.message,
      });
    }
  }
);

// Dashboard API Endpoints for Doctors
app.get(
  "/api/doctor/dashboard/overview",
  verifyToken,
  verifyDoctor,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const doctorUserId = req.user._id;

      // 1. Fetch the doctor's specific public directory profile to read fees and approval state
      const doctorProfile = await doctorsCollection.findOne({
        // Assuming your doctor profile links to the authentication user record via a userId field
        userId: new ObjectId(doctorUserId),
      });

      if (!doctorProfile) {
        return res.status(404).json({ success: false, message: "Doctor profile configuration not found." });
      }

      // 2. Compute date boundaries for today (Bangladesh Timezone Synchronization)
      const today = new Date();
      const todayStr = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().split("T")[0];

      // 3. Fetch all active bookings mapped to this doctor for today
      const todayBookings = await bookingsCollection
        .find({
          doctorId: doctorProfile._id,
          appointmentDate: todayStr,
          bookingStatus: { $in: ["Confirmed", "Completed", "Cancelled"] }
        })
        .sort({ appointmentTime: 1 })
        .toArray();

      // 4. Calculate metric counters out of today's snapshot payload
      const remainingToday = todayBookings.filter(b => b.bookingStatus === "Confirmed").length;
      const completedToday = todayBookings.filter(b => b.bookingStatus === "Completed").length;
      
      // Calculate earnings purely from completed or confirmed paid visits today
      const earningsToday = todayBookings
        .filter(b => b.bookingStatus !== "Cancelled" && b.paymentStatus === "Paid")
        .reduce((sum, b) => sum + (b.consultationFee || 0), 0);

      // 5. Package and return the structured overview payload
      res.status(200).json({
        success: true,
        data: {
          isApproved: doctorProfile.isApproved === true || doctorProfile.isApproved === "true",
          stats: {
            remainingToday,
            completedToday,
            earningsToday,
          },
          queue: todayBookings,
        },
      });
    } catch (error: any) {
      console.error("Doctor Dashboard Overview Error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to load clinical dashboard overview metrics.",
        error: error.message,
      });
    }
  }
);

app.get(
  "/api/doctor/profile",
  verifyToken,
  verifyDoctor,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const doctorUserId = req.user._id;

      const doctorProfile = await doctorsCollection.findOne({
        userId: new ObjectId(doctorUserId),
      });

      res.status(200).json({
        success: true,
        data: doctorProfile,
      });
    } catch (error: any) {
      console.error("Fetch Doctor Profile Error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to load clinical profile metrics.",
        error: error.message,
      });
    }
  }
);

app.post(
  "/api/doctor/profile",
  verifyToken,
  verifyDoctor,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const doctorUserId = req.user._id;
      const {
        name,
        title,
        image,
        specialty,
        fee,
        followUpFee,
        followUpWindowDays,
        location,
        bmdcNumber,
        experienceYears,
        hospitalAffiliation,
        biography,
      } = req.body;

      // Build the update configuration payload securely
      const updateDoc = {
        $set: {
          name,
          title,
          image,
          specialty,
          fee: Number(fee),
          followUpFee: Number(followUpFee),
          followUpWindowDays: Number(followUpWindowDays),
          location,
          bmdcNumber,
          experienceYears: Number(experienceYears),
          hospitalAffiliation,
          biography,
          updatedAt: new Date(),
        },
        // These fields are ONLY applied if the profile doesn't exist yet
        $setOnInsert: {
          userId: new ObjectId(doctorUserId),
          isApproved: false, // Strict default for new registrations
          createdAt: new Date(),
          patientSatisfactoryScore: { averageRating: 0, totalReviewsCount: 0 },
          experienceTimeline: [],
          weeklySlots: [],
          reviews: [],
        },
      };

      const result = await doctorsCollection.updateOne(
        { userId: new ObjectId(doctorUserId) },
        updateDoc,
        { upsert: true }
      );

      res.status(200).json({
        success: true,
        message: "Profile synchronized successfully.",
        data: result,
      });
    } catch (error: any) {
      console.error("Update Doctor Profile Error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to securely update profile.",
        error: error.message,
      });
    }
  }
);

app.put(
  "/api/doctor/schedule",
  verifyToken,
  verifyDoctor,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const doctorUserId = req.user._id;
      const { weeklySlots } = req.body;

      // Validate that weeklySlots is provided and is an array
      if (!Array.isArray(weeklySlots)) {
        return res.status(400).json({
          success: false,
          message: "Invalid payload format. Expected an array of weekly slots.",
        });
      }

      // Update ONLY the weeklySlots array for the authenticated doctor
      const result = await doctorsCollection.updateOne(
        { userId: new ObjectId(doctorUserId) },
        {
          $set: {
            weeklySlots: weeklySlots,
            updatedAt: new Date(),
          },
        }
      );

      if (result.matchedCount === 0) {
        return res.status(404).json({
          success: false,
          message: "Doctor profile not found. Please complete your profile onboarding first.",
        });
      }

      res.status(200).json({
        success: true,
        message: "Weekly schedule updated successfully.",
      });
    } catch (error: any) {
      console.error("Update Doctor Schedule Error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to update schedule rules.",
        error: error.message,
      });
    }
  }
);

app.get(
  "/api/doctor/earnings",
  verifyToken,
  verifyDoctor,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const doctorId = req.user._id;

      // Calculate the start of the current month (e.g., July 1, 2026)
      const now = new Date();
      const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      const earningsData = await bookingsCollection
        .aggregate([
          {
            $match: { doctorId: new ObjectId(doctorId) },
          },
          {
            $facet: {
              // Pipeline 1: Calculate high-level financial metrics
              metrics: [
                {
                  $group: {
                    _id: null,
                    totalEarned: {
                      $sum: {
                        $cond: [{ $eq: ["$paymentStatus", "Paid"] }, "$consultationFee", 0],
                      },
                    },
                    pendingAmount: {
                      $sum: {
                        $cond: [{ $ne: ["$paymentStatus", "Paid"] }, "$consultationFee", 0],
                      },
                    },
                    totalPaidAppointments: {
                      $sum: {
                        $cond: [{ $eq: ["$paymentStatus", "Paid"] }, 1, 0],
                      },
                    },
                    thisMonthEarned: {
                      $sum: {
                        $cond: [
                          {
                            $and: [
                              { $eq: ["$paymentStatus", "Paid"] },
                              { $gte: ["$createdAt", firstDayOfMonth] },
                            ],
                          },
                          "$consultationFee",
                          0,
                        ],
                      },
                    },
                  },
                },
              ],
              // Pipeline 2: Fetch the most recent 20 transactions for the ledger
              recentTransactions: [
                { $sort: { createdAt: -1 } },
                { $limit: 20 },
                {
                  $project: {
                    _id: 1,
                    appointmentDate: 1,
                    patientName: "$patientDetails.patientName",
                    stripeSessionId: 1,
                    paymentStatus: 1,
                    consultationFee: 1,
                  },
                },
              ],
            },
          },
        ])
        .toArray();

      // Extract from the facet structure or provide safe zero-defaults
      const result = earningsData[0];
      const metrics = result?.metrics?.[0] || {
        totalEarned: 0,
        pendingAmount: 0,
        totalPaidAppointments: 0,
        thisMonthEarned: 0,
      };
      
      const transactions = result?.recentTransactions || [];

      res.status(200).json({
        success: true,
        data: {
          metrics,
          transactions,
        },
      });
    } catch (error: any) {
      console.error("Fetch Doctor Earnings Error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to generate financial report.",
        error: error.message,
      });
    }
  }
);

// Dashboard API Endpoints for Admins
app.get(
  "/api/admin/overview",
  verifyToken,
  verifyAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      // 1. Time constraints for calculations
      const now = new Date();
      const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);

      // Define your platform's profit cut (e.g., 10%)
      const PLATFORM_COMMISSION_RATE = 0.10; 

      // 2. Execute all queries concurrently for maximum speed
      const [usersCount, doctorsCount, financialData, specialtyData] = await Promise.all([
        usersCollection.estimatedDocumentCount(),
        doctorsCollection.countDocuments({ isApproved: true }),
        
        // 3. Financial & Trend Aggregation
        bookingsCollection.aggregate([
          { $match: { paymentStatus: "Paid" } },
          {
            $facet: {
              totals: [
                {
                  $group: {
                    _id: null,
                    totalVolume: { $sum: "$consultationFee" },
                    monthlyVolume: {
                      $sum: {
                        $cond: [{ $gte: ["$createdAt", firstDayOfMonth] }, "$consultationFee", 0]
                      }
                    }
                  }
                }
              ],
              monthlyTrend: [
                { $match: { createdAt: { $gte: sixMonthsAgo } } },
                {
                  $group: {
                    _id: { month: { $month: "$createdAt" }, year: { $year: "$createdAt" } },
                    revenue: { $sum: "$consultationFee" }
                  }
                },
                { $sort: { "_id.year": 1, "_id.month": 1 } }
              ]
            }
          }
        ]).toArray(),

        // 4. Specialty Appointments Aggregation (Requires Lookup)
        bookingsCollection.aggregate([
          { $match: { paymentStatus: "Paid" } },
          {
            $lookup: {
              from: "doctors", // Ensure this matches your actual MongoDB collection name
              localField: "doctorId",
              foreignField: "_id",
              as: "doctorDetails"
            }
          },
          { $unwind: "$doctorDetails" },
          {
            $group: {
              _id: "$doctorDetails.specialty",
              appointments: { $sum: 1 }
            }
          },
          { $sort: { appointments: -1 } },
          { $limit: 5 } // Top 5 specialties
        ]).toArray()
      ]);

      // 5. Format Data for the Frontend
      const financials = financialData[0];
      const totalVolume = financials?.totals[0]?.totalVolume || 0;
      const monthlyVolume = financials?.totals[0]?.monthlyVolume || 0;

      // Map month numbers to short names for Recharts
      const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
      
      const formattedTrend = financials?.monthlyTrend.map((item: any) => ({
        name: monthNames[item._id.month - 1],
        revenue: item.revenue * PLATFORM_COMMISSION_RATE
      })) || [];

      const formattedSpecialties = specialtyData.map((item: any) => ({
        name: item._id || "Unknown",
        appointments: item.appointments
      }));

      // 6. Send Response
      res.status(200).json({
        success: true,
        data: {
          metrics: {
            totalProfit: totalVolume * PLATFORM_COMMISSION_RATE,
            monthlyProfit: monthlyVolume * PLATFORM_COMMISSION_RATE,
            activeDoctors: doctorsCount,
            totalUsers: usersCount
          },
          charts: {
            revenueTrend: formattedTrend,
            specialtyDistribution: formattedSpecialties
          }
        }
      });

    } catch (error: any) {
      console.error("Admin Overview Aggregation Error:", error);
      res.status(500).json({
        success: false,
        message: "Failed to generate admin overview.",
        error: error.message
      });
    }
  }
);

// 1. GET PATIENT PROFILE DATA
app.get(
  "/api/patient/profile",
  verifyToken,
  verifyPatient,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user._id;

      // Find extended profile information if it exists
      const extendedProfile = await profilesCollection.findOne({
        userId: new ObjectId(userId),
      });

      // Combine BetterAuth core user data with our extended medical data
      res.status(200).json({
        success: true,
        data: {
          name: req.user.name,
          email: req.user.email,
          phone: extendedProfile?.phone || "",
          gender: extendedProfile?.gender || "",
          dateOfBirth: extendedProfile?.dateOfBirth || "",
          bloodGroup: extendedProfile?.bloodGroup || "",
          address: extendedProfile?.address || "",
          emergencyContact: extendedProfile?.emergencyContact || "",
        },
      });
    } catch (error: any) {
      console.error("Fetch Profile Error:", error);
      res.status(500).json({ success: false, message: "Failed to load profile state", error: error.message });
    }
  }
);

// 2. UPDATE / UPSERT PATIENT PROFILE DATA
app.post(
  "/api/patient/profile",
  verifyToken,
  verifyPatient,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user._id;
      const { name, phone, gender, dateOfBirth, bloodGroup, address, emergencyContact } = req.body;

      // Update core user display name in BetterAuth users collection
      await usersCollection.updateOne(
        { _id: new ObjectId(userId) },
        { $set: { name, updatedAt: new Date() } }
      );

      // Upsert extended details inside our custom profiles collection
      await profilesCollection.updateOne(
        { userId: new ObjectId(userId) },
        {
          $set: {
            phone,
            gender,
            dateOfBirth,
            bloodGroup,
            address,
            emergencyContact,
            updatedAt: new Date(),
          },
        },
        { upsert: true } // Creates the document if it doesn't exist yet
      );

      res.status(200).json({ success: true, message: "Profile synchronized successfully" });
    } catch (error: any) {
      console.error("Update Profile Error:", error);
      res.status(500).json({ success: false, message: "Failed to update profile changes", error: error.message });
    }
  }
);

app.listen(port, () => {
  console.log(`Healora API listening smoothly on port ${port}`);
});

export default app;