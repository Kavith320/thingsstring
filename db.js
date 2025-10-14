import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();


const uri = process.env.MONGODB_URI;
if (!uri) {
console.error('❌ Missing MONGODB_URI in .env');
process.exit(1);
}


mongoose.set('strictQuery', true);


export async function connectMongo() {
await mongoose.connect(uri);
console.log('✅ MongoDB connected');
}