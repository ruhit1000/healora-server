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
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET as string;

app.use(cors({ origin: clientUrl }));

interface AuthenticatedRequest extends Request {
  user?: any;
}

// Global Database Context
let database: Db;
let sessionsCollection: Collection;
let usersCollection: Collection;
let doctorsCollection: Collection;
let bookingsCollection: Collection;
let profilesCollection: Collection;

const uri = process.env.MONGO_URI || "";
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

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
    await bookingsCollection.createIndex(
      { lockExpiresAt: 1 },
      { expireAfterSeconds: 0 },
    );
    await bookingsCollection.createIndex(
      { doctorId: 1, appointmentDate: 1, appointmentTime: 1 },
      { unique: true },
    );

    console.log(
      "🔒 Core system performance indexes synchronized successfully.",
    );
  } catch (error) {
    console.error("❌ Failed to bind native MongoDB instance:", error);
  }
}
bootstrapServer();

/* =========================================================================
   STRIPE WEBHOOK (RAW SYSTEM BODY PARSING PRIOR TO GENERAL EXPRESS USE)
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
              $unset: { lockExpiresAt: "" },
            },
          );
          console.log(`✅ SUCCESS: Booking ${bookingId} confirmed.`);
        } catch (dbError) {
          console.error("Failed to update booking status in MongoDB:", dbError);
        }
      }
    }
    res.status(200).send();
  },
);

app.use(express.json());

/* =========================================================================
   SECURITY ACCESS LAYER CONTROL MIDDLEWARE
   ========================================================================= */
const verifyToken = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).send({ message: "Unauthorized Access" });

    const token = authHeader.split(" ")[1];
    if (!token) return res.status(401).send({ message: "Unauthorized Access" });

    const session = await sessionsCollection.findOne({ token: token });
    if (!session)
      return res.status(401).send({ message: "Unauthorized Access" });

    const user = await usersCollection.findOne({
      _id: new ObjectId(session.userId as string),
    });
    if (!user) return res.status(401).send({ message: "Unauthorized Access" });

    req.user = user;
    next();
  } catch (error: any) {
    return res
      .status(500)
      .send({ message: "Internal Auth Exception", error: error.message });
  }
};

const verifyAdmin = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  if (req.user?.role !== "admin")
    return res.status(403).send({ message: "Forbidden Access" });
  next();
};

const verifyDoctor = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  if (req.user?.role !== "doctor")
    return res.status(403).send({ message: "Forbidden Access" });
  next();
};

const verifyPatient = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
) => {
  if (req.user?.role !== "patient")
    return res.status(403).send({ message: "Forbidden Access" });
  next();
};

/* =========================================================================
   PUBLIC SYSTEM ACCESS CONTROL ROUTES
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
        totalPages: Math.ceil(totalMatchingDoctors / itemsPerPage),
        currentPage,
        limit: itemsPerPage,
      },
      data: doctors,
    });
  } catch (error: any) {
    res.status(500).json({
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
    res.status(500).json({
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
    if (!doctor)
      return res
        .status(404)
        .json({ success: false, message: "Profile not found" });
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
   PATIENT RESERVATION CONTROL PANEL ROUTES
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

    res
      .status(200)
      .json({ success: true, data: bookedSlots.map((b) => b.appointmentTime) });
  } catch (error: any) {
    res.status(500).json({
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
          message: "This slot was just booked by someone else.",
        });
      }

      const doctor = await doctorsCollection.findOne({
        _id: new ObjectId(doctorId as string),
      });
      if (!doctor)
        return res
          .status(404)
          .json({ success: false, message: "Doctor not found." });

      const now = new Date();
      const lockExpiration = new Date(now.getTime() + 10 * 60 * 1000);

      const newBookingDocument = {
        patientUserId,
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

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        mode: "payment",
        customer_email: req.user?.email || undefined,
        line_items: [
          {
            price_data: {
              currency: "bdt",
              product_data: {
                name: `Consultation with ${doctor.name}`,
                description: `${appointmentDate} @ ${appointmentTime}`,
              },
              unit_amount: Math.round(doctor.fee * 100),
            },
            quantity: 1,
          },
        ],
        metadata: { bookingId: insertResult.insertedId.toString() },
        success_url: `${clientUrl}/booking-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${clientUrl}/doctors/${doctorId}?payment=cancelled`,
      });

      await bookingsCollection.updateOne(
        { _id: insertResult.insertedId },
        { $set: { stripeSessionId: session.id, updatedAt: new Date() } },
      );
      res.status(200).json({ success: true, url: session.url });
    } catch (error: any) {
      if (error.code === 11000)
        return res.status(409).json({
          success: false,
          message: "This slot was just booked by someone else.",
        });
      res.status(500).json({
        success: false,
        message: "Checkout failed",
        error: error.message,
      });
    }
  },
);

app.get(
  "/api/patient/dashboard/overview",
  verifyToken,
  verifyPatient,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const patientUserId = req.user._id;
      const today = new Date();
      const todayStr = new Date(
        today.getTime() - today.getTimezoneOffset() * 60000,
      )
        .toISOString()
        .split("T")[0];

      const upcomingBookings = await bookingsCollection
        .find({
          patientUserId,
          bookingStatus: "Confirmed",
          appointmentDate: { $gte: todayStr },
        })
        .sort({ appointmentDate: 1, appointmentTime: 1 })
        .toArray();

      let nextAppointment = upcomingBookings[0] || null;
      if (nextAppointment) {
        nextAppointment.doctorDetails = await doctorsCollection.findOne(
          { _id: new ObjectId(nextAppointment.doctorId) },
          { projection: { name: 1, specialty: 1, location: 1, image: 1 } },
        );
      }

      const paidBookings = await bookingsCollection
        .find({ patientUserId, paymentStatus: "Paid" })
        .project({ consultationFee: 1 })
        .toArray();
      const totalSpent = paidBookings.reduce(
        (sum, booking) => sum + (booking.consultationFee || 0),
        0,
      );
      const completedCount = await bookingsCollection.countDocuments({
        patientUserId,
        bookingStatus: "Completed",
      });

      const recentActivity = await bookingsCollection
        .find({
          patientUserId,
          $or: [
            { bookingStatus: { $in: ["Completed", "Cancelled"] } },
            { appointmentDate: { $lt: todayStr } },
          ],
        })
        .sort({ appointmentDate: -1, createdAt: -1 })
        .limit(3)
        .toArray();

      const recentActivityWithDoctors = await Promise.all(
        recentActivity.map(async (activity) => {
          const doctor = await doctorsCollection.findOne(
            { _id: new ObjectId(activity.doctorId) },
            { projection: { name: 1, specialty: 1 } },
          );
          return { ...activity, doctorDetails: doctor };
        }),
      );

      res.status(200).json({
        success: true,
        data: {
          stats: {
            upcomingCount: upcomingBookings.length,
            completedCount,
            totalSpent,
          },
          nextAppointment,
          recentActivity: recentActivityWithDoctors,
        },
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to load dashboard data",
        error: error.message,
      });
    }
  },
);

app.get(
  "/api/patient/dashboard/appointments",
  verifyToken,
  verifyPatient,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const patientUserId = req.user._id;
      const today = new Date();
      const todayStr = new Date(
        today.getTime() - today.getTimezoneOffset() * 60000,
      )
        .toISOString()
        .split("T")[0];

      const appointments = await bookingsCollection
        .find({
          patientUserId,
          bookingStatus: { $in: ["Confirmed", "Locked"] },
          appointmentDate: { $gte: todayStr },
        })
        .sort({ appointmentDate: 1, appointmentTime: 1 })
        .toArray();

      const populatedAppointments = await Promise.all(
        appointments.map(async (appt) => {
          const doctor = await doctorsCollection.findOne(
            { _id: new ObjectId(appt.doctorId) },
            { projection: { name: 1, specialty: 1, image: 1, location: 1 } },
          );
          return { ...appt, doctorDetails: doctor };
        }),
      );

      res.status(200).json({
        success: true,
        data: {
          confirmed: populatedAppointments.filter(
            (a: any) => a.bookingStatus === "Confirmed",
          ),
          pending: populatedAppointments.filter(
            (a: any) => a.bookingStatus === "Locked",
          ),
        },
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to load appointments",
        error: error.message,
      });
    }
  },
);

app.get(
  "/api/patient/dashboard/history",
  verifyToken,
  verifyPatient,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const patientUserId = req.user._id;
      const today = new Date();
      const todayStr = new Date(
        today.getTime() - today.getTimezoneOffset() * 60000,
      )
        .toISOString()
        .split("T")[0];

      const history = await bookingsCollection
        .find({
          patientUserId,
          $or: [
            { bookingStatus: { $in: ["Completed", "Cancelled"] } },
            { appointmentDate: { $lt: todayStr } },
          ],
        })
        .sort({ appointmentDate: -1, appointmentTime: -1 })
        .toArray();

      const populatedHistory = await Promise.all(
        history.map(async (appt) => {
          const doctor = await doctorsCollection.findOne(
            { _id: new ObjectId(appt.doctorId) },
            { projection: { name: 1, specialty: 1, image: 1 } },
          );
          return { ...appt, doctorDetails: doctor };
        }),
      );

      res.status(200).json({ success: true, data: populatedHistory });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to load consultation history",
        error: error.message,
      });
    }
  },
);

app.get(
  "/api/patient/profile",
  verifyToken,
  verifyPatient,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const extendedProfile = await profilesCollection.findOne({
        userId: new ObjectId(req.user._id),
      });
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
      res.status(500).json({
        success: false,
        message: "Failed to load profile state",
        error: error.message,
      });
    }
  },
);

app.post(
  "/api/patient/profile",
  verifyToken,
  verifyPatient,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const userId = req.user._id;
      const {
        name,
        phone,
        gender,
        dateOfBirth,
        bloodGroup,
        address,
        emergencyContact,
      } = req.body;

      await usersCollection.updateOne(
        { _id: new ObjectId(userId) },
        { $set: { name, updatedAt: new Date() } },
      );
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
        { upsert: true },
      );

      res
        .status(200)
        .json({ success: true, message: "Profile synchronized successfully" });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to update profile changes",
        error: error.message,
      });
    }
  },
);

/* =========================================================================
   PRACTITIONER CONTROL PANEL ROUTES
   ========================================================================= */
app.get(
  "/api/doctor/dashboard/overview",
  verifyToken,
  verifyDoctor,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const doctorProfile = await doctorsCollection.findOne({
        userId: new ObjectId(req.user._id),
      });
      if (!doctorProfile)
        return res.status(404).json({
          success: false,
          message: "Doctor profile configuration not found.",
        });

      const today = new Date();
      const todayStr = new Date(
        today.getTime() - today.getTimezoneOffset() * 60000,
      )
        .toISOString()
        .split("T")[0];

      const todayBookings = await bookingsCollection
        .find({
          doctorId: doctorProfile._id,
          appointmentDate: todayStr,
          bookingStatus: { $in: ["Confirmed", "Completed", "Cancelled"] },
        })
        .sort({ appointmentTime: 1 })
        .toArray();

      res.status(200).json({
        success: true,
        data: {
          isApproved:
            doctorProfile.isApproved === true ||
            doctorProfile.isApproved === "true",
          stats: {
            remainingToday: todayBookings.filter(
              (b) => b.bookingStatus === "Confirmed",
            ).length,
            completedToday: todayBookings.filter(
              (b) => b.bookingStatus === "Completed",
            ).length,
            earningsToday: todayBookings
              .filter(
                (b) =>
                  b.bookingStatus !== "Cancelled" && b.paymentStatus === "Paid",
              )
              .reduce((sum, b) => sum + (b.consultationFee || 0), 0),
          },
          queue: todayBookings,
        },
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to load clinical dashboard overview metrics.",
        error: error.message,
      });
    }
  },
);

app.get(
  "/api/doctor/profile",
  verifyToken,
  verifyDoctor,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const doctorProfile = await doctorsCollection.findOne({
        userId: new ObjectId(req.user._id),
      });
      res.status(200).json({ success: true, data: doctorProfile });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to load clinical profile metrics.",
        error: error.message,
      });
    }
  },
);

app.post(
  "/api/doctor/profile",
  verifyToken,
  verifyDoctor,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
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
      const userId = new ObjectId(req.user._id);

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
        $setOnInsert: {
          userId,
          isApproved: false,
          createdAt: new Date(),
          patientSatisfactoryScore: { averageRating: 0, totalReviewsCount: 0 },
          experienceTimeline: [],
          weeklySlots: [],
          reviews: [],
        },
      };

      const result = await doctorsCollection.updateOne({ userId }, updateDoc, {
        upsert: true,
      });
      res.status(200).json({
        success: true,
        message: "Profile synchronized successfully.",
        data: result,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to securely update profile.",
        error: error.message,
      });
    }
  },
);

app.put(
  "/api/doctor/schedule",
  verifyToken,
  verifyDoctor,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { weeklySlots } = req.body;
      if (!Array.isArray(weeklySlots))
        return res.status(400).json({
          success: false,
          message: "Invalid payload format. Expected an array.",
        });

      const result = await doctorsCollection.updateOne(
        { userId: new ObjectId(req.user._id) },
        { $set: { weeklySlots, updatedAt: new Date() } },
      );
      if (result.matchedCount === 0)
        return res
          .status(404)
          .json({ success: false, message: "Doctor profile not found." });

      res.status(200).json({
        success: true,
        message: "Weekly schedule updated successfully.",
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to update schedule rules.",
        error: error.message,
      });
    }
  },
);

app.get(
  "/api/doctor/earnings",
  verifyToken,
  verifyDoctor,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const now = new Date();
      const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

      const earningsData = await bookingsCollection
        .aggregate([
          { $match: { doctorId: new ObjectId(req.user._id) } },
          {
            $facet: {
              metrics: [
                {
                  $group: {
                    _id: null,
                    totalEarned: {
                      $sum: {
                        $cond: [
                          { $eq: ["$paymentStatus", "Paid"] },
                          "$consultationFee",
                          0,
                        ],
                      },
                    },
                    pendingAmount: {
                      $sum: {
                        $cond: [
                          { $ne: ["$paymentStatus", "Paid"] },
                          "$consultationFee",
                          0,
                        ],
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

      const result = earningsData[0];
      res.status(200).json({
        success: true,
        data: {
          metrics: result?.metrics?.[0] || {
            totalEarned: 0,
            pendingAmount: 0,
            totalPaidAppointments: 0,
            thisMonthEarned: 0,
          },
          transactions: result?.recentTransactions || [],
        },
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to generate financial report.",
        error: error.message,
      });
    }
  },
);

/* =========================================================================
   ADMINISTRATIVE PLATFORM MANAGEMENT CONTROL ROUTES
   ========================================================================= */
app.get(
  "/api/admin/overview",
  verifyToken,
  verifyAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const now = new Date();
      const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const sixMonthsAgo = new Date(now.getFullYear(), now.getMonth() - 5, 1);
      const PLATFORM_COMMISSION_RATE = 0.1;

      const [usersCount, doctorsCount, financialData, specialtyData] =
        await Promise.all([
          usersCollection.estimatedDocumentCount(),
          doctorsCollection.countDocuments({ isApproved: true }),

          bookingsCollection
            .aggregate([
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
                            $cond: [
                              { $gte: ["$createdAt", firstDayOfMonth] },
                              "$consultationFee",
                              0,
                            ],
                          },
                        },
                      },
                    },
                  ],
                  monthlyTrend: [
                    { $match: { createdAt: { $gte: sixMonthsAgo } } },
                    {
                      $group: {
                        _id: {
                          month: { $month: "$createdAt" },
                          year: { $year: "$createdAt" },
                        },
                        revenue: { $sum: "$consultationFee" },
                      },
                    },
                    { $sort: { "_id.year": 1, "_id.month": 1 } },
                  ],
                },
              },
            ])
            .toArray(),

          bookingsCollection
            .aggregate([
              { $match: { paymentStatus: "Paid" } },
              {
                $lookup: {
                  from: "doctors",
                  localField: "doctorId",
                  foreignField: "_id",
                  as: "doctorDetails",
                },
              },
              { $unwind: "$doctorDetails" },
              {
                $group: {
                  _id: "$doctorDetails.specialty",
                  appointments: { $sum: 1 },
                },
              },
              { $sort: { appointments: -1 } },
              { $limit: 5 },
            ])
            .toArray(),
        ]);

      const financials = financialData[0];
      const totalVolume = financials?.totals[0]?.totalVolume || 0;
      const monthlyVolume = financials?.totals[0]?.monthlyVolume || 0;
      const monthNames = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];

      res.status(200).json({
        success: true,
        data: {
          metrics: {
            totalProfit: totalVolume * PLATFORM_COMMISSION_RATE,
            monthlyProfit: monthlyVolume * PLATFORM_COMMISSION_RATE,
            activeDoctors: doctorsCount,
            totalUsers: usersCount,
          },
          charts: {
            revenueTrend:
              financials?.monthlyTrend.map((item: any) => ({
                name: monthNames[item._id.month - 1],
                revenue: item.revenue * PLATFORM_COMMISSION_RATE,
              })) || [],
            specialtyDistribution: specialtyData.map((item: any) => ({
              name: item._id || "Unknown",
              appointments: item.appointments,
            })),
          },
        },
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to generate admin overview.",
        error: error.message,
      });
    }
  },
);

app.get(
  "/api/admin/doctors",
  verifyToken,
  verifyAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const doctors = await doctorsCollection
        .aggregate([
          {
            $lookup: {
              from: "user",
              localField: "userId",
              foreignField: "_id",
              as: "userDetails",
            },
          },
          {
            $unwind: { path: "$userDetails", preserveNullAndEmptyArrays: true },
          },
          { $addFields: { email: "$userDetails.email" } },
          { $project: { userDetails: 0 } },
          { $sort: { createdAt: -1 } },
        ])
        .toArray();

      res.status(200).json({ success: true, data: doctors });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to fetch doctors list.",
        error: error.message,
      });
    }
  },
);

app.patch(
  "/api/admin/doctors/:id/status",
  verifyToken,
  verifyAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const doctorId = req.params.id;
      const { action } = req.body;
      if (!ObjectId.isValid(doctorId as string))
        return res
          .status(400)
          .json({ success: false, message: "Invalid Doctor ID" });

      let updateFields = {};
      if (action === "approve")
        updateFields = { isApproved: true, status: "Approved" };
      else if (action === "reject")
        updateFields = { isApproved: false, status: "Rejected" };
      else if (action === "suspend")
        updateFields = { isApproved: false, status: "Suspended" };
      else
        return res
          .status(400)
          .json({ success: false, message: "Invalid action" });

      const result = await doctorsCollection.updateOne(
        { _id: new ObjectId(doctorId as string) },
        { $set: updateFields },
      );
      if (result.matchedCount === 0)
        return res
          .status(404)
          .json({ success: false, message: "Doctor not found" });

      res
        .status(200)
        .json({ success: true, message: `Doctor successfully ${action}d.` });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to update doctor status.",
        error: error.message,
      });
    }
  },
);

app.get(
  "/api/admin/bookings",
  verifyToken,
  verifyAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const skip = (page - 1) * limit;
      const statusFilter = req.query.status as string;
      const searchQuery = req.query.search as string;

      const matchStage: any = {};
      if (statusFilter && statusFilter !== "All")
        matchStage.paymentStatus = statusFilter;

      const aggregationResult = await bookingsCollection
        .aggregate([
          { $match: matchStage },
          {
            $lookup: {
              from: "doctors",
              localField: "doctorId",
              foreignField: "_id",
              as: "doctorInfo",
            },
          },
          {
            $unwind: { path: "$doctorInfo", preserveNullAndEmptyArrays: true },
          },
          ...(searchQuery
            ? [
                {
                  $match: {
                    $or: [
                      {
                        "patientDetails.patientName": {
                          $regex: searchQuery,
                          $options: "i",
                        },
                      },
                      {
                        "doctorInfo.name": {
                          $regex: searchQuery,
                          $options: "i",
                        },
                      },
                      {
                        "doctorInfo.specialty": {
                          $regex: searchQuery,
                          $options: "i",
                        },
                      },
                    ],
                  },
                },
              ]
            : []),
          {
            $facet: {
              metaSummary: [
                {
                  $group: {
                    _id: null,
                    totalRecords: { $sum: 1 },
                    grossVolume: {
                      $sum: {
                        $cond: [
                          { $eq: ["$paymentStatus", "Paid"] },
                          "$consultationFee",
                          0,
                        ],
                      },
                    },
                    completedCount: {
                      $sum: {
                        $cond: [{ $eq: ["$bookingStatus", "Completed"] }, 1, 0],
                      },
                    },
                    pendingPaymentCount: {
                      $sum: {
                        $cond: [{ $eq: ["$paymentStatus", "Pending"] }, 1, 0],
                      },
                    },
                  },
                },
              ],
              recordsData: [
                { $sort: { createdAt: -1 } },
                { $skip: skip },
                { $limit: limit },
                {
                  $project: {
                    _id: 1,
                    appointmentDate: 1,
                    appointmentTime: 1,
                    consultationFee: 1,
                    paymentStatus: 1,
                    appointmentStatus: "$bookingStatus",
                    createdAt: 1,
                    patientName: "$patientDetails.patientName",
                    doctorName: "$doctorInfo.name",
                    doctorSpecialty: "$doctorInfo.specialty",
                  },
                },
              ],
            },
          },
        ])
        .toArray();

      const facetData = aggregationResult[0];
      const stats = facetData?.metaSummary[0] || {
        totalRecords: 0,
        grossVolume: 0,
        completedCount: 0,
        pendingPaymentCount: 0,
      };

      res.status(200).json({
        success: true,
        metrics: {
          totalAppointments: stats.totalRecords,
          grossVolume: stats.grossVolume,
          completedCount: stats.completedCount,
          pendingPaymentCount: stats.pendingPaymentCount,
        },
        pagination: {
          currentPage: page,
          limit,
          totalPages: Math.ceil(stats.totalRecords / limit) || 1,
          totalResults: stats.totalRecords,
        },
        data: facetData?.recordsData || [],
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to compile the system bookings ledger.",
        error: error.message,
      });
    }
  },
);

app.get(
  "/api/admin/users",
  verifyToken,
  verifyAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const page = parseInt(req.query.page as string) || 1;
      const limit = parseInt(req.query.limit as string) || 10;
      const skip = (page - 1) * limit;
      const roleFilter = req.query.role as string;
      const searchQuery = req.query.search as string;

      const matchStage: any = {};
      if (roleFilter && roleFilter !== "All")
        matchStage.role = roleFilter.toLowerCase();
      if (searchQuery)
        matchStage.$or = [
          { name: { $regex: searchQuery, $options: "i" } },
          { email: { $regex: searchQuery, $options: "i" } },
        ];

      const aggregationResult = await usersCollection
        .aggregate([
          { $match: matchStage },
          {
            $facet: {
              metaSummary: [{ $count: "totalRecords" }],
              recordsData: [
                { $sort: { createdAt: -1 } },
                { $skip: skip },
                { $limit: limit },
                {
                  $project: {
                    _id: 1,
                    name: 1,
                    email: 1,
                    role: 1,
                    createdAt: 1,
                  },
                },
              ],
            },
          },
        ])
        .toArray();

      const facetData = aggregationResult[0];
      const totalResults = facetData?.metaSummary[0]?.totalRecords || 0;

      res.status(200).json({
        success: true,
        pagination: {
          currentPage: page,
          limit,
          totalPages: Math.ceil(totalResults / limit) || 1,
          totalResults,
        },
        data: facetData?.recordsData || [],
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to fetch platform users list.",
        error: error.message,
      });
    }
  },
);

app.patch(
  "/api/admin/users/:id/role",
  verifyToken,
  verifyAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const targetUserId = req.params.id;
      const { targetRole } = req.body;

      if (!ObjectId.isValid(targetUserId as string))
        return res
          .status(400)
          .json({ success: false, message: "Invalid User ID format." });
      if (targetRole !== "admin" && targetRole !== "patient")
        return res
          .status(400)
          .json({ success: false, message: "Invalid role assignment." });

      if (
        req.user?._id &&
        req.user._id.toString() === targetUserId &&
        targetRole !== "admin"
      ) {
        return res.status(403).json({
          success: false,
          message:
            "Security violation: You cannot revoke your own administrative clearance.",
        });
      }

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(targetUserId as string) },
        { $set: { role: targetRole } },
      );
      if (result.matchedCount === 0)
        return res
          .status(404)
          .json({ success: false, message: "Target user account not found." });

      res.status(200).json({
        success: true,
        message: `User account role successfully modified to ${targetRole}.`,
      });
    } catch (error: any) {
      res.status(500).json({
        success: false,
        message: "Failed to process role adjustment request.",
        error: error.message,
      });
    }
  },
);

// Only listen locally. Vercel will handle the routing in production.
if (process.env.NODE_ENV !== "production") {
  app.listen(port, () => {
    console.log(`Healora API listening smoothly on port ${port}`);
  });
}

// Vercel REQUIRES this export to mount your Express app
export default app;
