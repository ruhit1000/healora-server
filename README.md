# 🩺 CareSlot Server – Backend API

The CareSlot Server powers the doctor appointment platform by providing secure RESTful APIs for authentication, role-based authorization, appointment management, doctor verification, and concurrent slot booking. Built with Next.js API Routes, TypeScript, MongoDB, and Mongoose, the backend ensures scalability, security, and reliable appointment scheduling.

---

## 🌐 Live API

**Base URL:** https://healora-server.onrender.com

---

## 📂 Client Repository

https://github.com/ruhit1000/healora-client

## 📂 Server Repository

https://github.com/ruhit1000/healora-server

---

# 🚀 Features

### 🔐 Authentication

- JWT Authentication
- Secure Login & Registration
- Protected API Routes
- Password Hashing
- Role-Based Authorization (RBAC)

---

### 👥 User Management

- Patient Registration
- Doctor Registration
- Admin Management
- User Profile Management
- Block Users
- Delete Users

---

### 👨‍⚕️ Doctor Management

- Doctor Profile Creation
- Doctor Verification
- Approval/Rejection Workflow
- Specialty Management
- Consultation Fee Management
- Availability Scheduling

---

### 📅 Appointment Management

- Create Appointment
- Cancel Appointment
- Appointment History
- Appointment Status Updates
- Patient Notes
- Appointment Validation

---

### ⏰ Time Slot Management

- Generate Daily Slots
- Weekly Availability
- Update Slot Status
- Delete Slots
- Lock Slots During Booking
- Automatic Slot Release

---

### ⚡ Concurrency Control

- Prevent Double Booking
- Temporary Slot Locking
- Pending Booking State
- Automatic Lock Expiration
- Atomic Database Updates

---

### 📊 Dashboard APIs

#### Patient Dashboard

- Upcoming Appointments
- Appointment History
- Dashboard Statistics

#### Doctor Dashboard

- Patient List
- Daily Schedule
- Appointment Analytics
- Revenue Analytics

#### Admin Dashboard

- Doctor Approval Queue
- User Management
- Platform Analytics
- System Statistics

---

# 🛠 Tech Stack

- Next.js API Routes
- TypeScript
- MongoDB
- Mongoose
- JWT Authentication
- NextAuth.js
- Vercel Serverless Functions

---

# 📂 Project Structure

```
src/
│
├── app/
│   └── api/
│
├── models/
│
├── controllers/
│
├── services/
│
├── middleware/
│
├── lib/
│
├── utils/
│
├── types/
│
└── config/
```

---

## Users

```ts
{
  _id,
  name,
  email,
  passwordHash,
  role,
  createdAt
}
```

---

## Doctor Profiles

```ts
{
  userId,
  specialty,
  experience,
  fee,
  bio,
  rating,
  status
}
```

---

## Time Slots

```ts
{
  doctorId,
  startTime,
  endTime,
  status,
  lockedAt
}
```

---

## Appointments

```ts
{
  patientId,
  doctorId,
  slotId,
  status,
  patientNotes
}
```

---

# 🔒 Security

- JWT Authentication
- Role-Based Access Control
- Protected Routes
- Secure Password Hashing
- Request Validation
- MongoDB Injection Protection
- Authorization Middleware

---

# ⚡ Concurrency Engine

CareSlot uses a slot-locking mechanism to eliminate race conditions during appointment booking.

### Booking Flow

1. Patient selects a slot.
2. Slot status changes from **Available** to **Pending**.
3. The slot is locked for a limited time.
4. Patient completes the booking.
5. Slot becomes **Booked**.
6. If the booking isn't completed within the timeout period, the slot automatically returns to **Available**.

This ensures two users cannot reserve the same appointment simultaneously.

---

# 🔗 Main API Endpoints

## Authentication

```
POST   /api/auth/register
POST   /api/auth/login
GET    /api/auth/profile
```

---

## Doctors

```
GET    /api/doctors
GET    /api/doctors/:id
POST   /api/doctors
PATCH  /api/doctors/:id
DELETE /api/doctors/:id
```

---

## Time Slots

```
GET    /api/slots
POST   /api/slots
PATCH  /api/slots/:id
DELETE /api/slots/:id
```

---

## Appointments

```
GET    /api/appointments
POST   /api/appointments
PATCH  /api/appointments/:id
DELETE /api/appointments/:id
```

---

## Admin

```
GET    /api/admin/users
GET    /api/admin/doctors
PATCH  /api/admin/approve/:id
PATCH  /api/admin/block/:id
DELETE /api/admin/users/:id
```

---

# ⚙ Environment Variables

Create a `.env.local` file.

```env
MONGODB_URI=

NEXTAUTH_SECRET=

NEXTAUTH_URL=

JWT_SECRET=
```

---

# 📦 Installation

Clone the repository

```bash
git clone https://github.com/your-username/careslot-server.git
```

Move into the project

```bash
cd careslot-server
```

Install dependencies

```bash
npm install
```

Run the development server

```bash
npm run dev
```

The server will start at:

```
http://localhost:8001/api
```

---

# 🚀 Deployment

This backend is optimized for deployment on **Vercel** with **MongoDB Atlas** as the database.

---

# 📌 Future Improvements

- Payment Integration
- Email Notifications
- SMS Reminders
- Video Consultation APIs
- Cloud File Uploads
- Prescription APIs
- Medical Records
- WebSocket Notifications
- Rate Limiting
- API Documentation with Swagger

---

# 🤝 Contributing

Contributions are welcome!

1. Fork the repository
2. Create a new feature branch
3. Commit your changes
4. Push to your branch
5. Open a Pull Request

---

# 📄 License

This project is licensed under the **MIT License**.

---

# 👨‍💻 Author

**Ruhit**

Full-Stack Developer passionate about building secure, scalable, and high-performance backend systems with modern web technologies.