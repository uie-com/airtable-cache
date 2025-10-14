import { NextRequest, NextResponse } from 'next/server';

export async function POST(request: NextRequest) {
    try {
        const { searchParams } = new URL(request.url);
        const endpoint = searchParams.get('endpoint');

        if (!endpoint) {
            return NextResponse.json(
                { error: 'Endpoint parameter is required' },
                { status: 400 }
            );
        }

        const body = await request.json();

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });

        const data = await response.json();

        return NextResponse.json(data, { status: response.status });
    } catch (error) {
        return NextResponse.json(
            { error: 'Failed to forward request' },
            { status: 500 }
        );
    }
}